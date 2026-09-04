import { test } from "node:test";
import assert from "node:assert/strict";
import {
  descendantsOf,
  parseLsof,
  parseNetstat,
  parseProcNetTcp,
  parsePsTree,
} from "../src/workspaces/ports.ts";

// Verbatim shape of `lsof -a -p <pids> -iTCP -sTCP:LISTEN -P -n` on macOS,
// plus a stray non-LISTEN row and a garbage line the parser must survive.
const LSOF_FIXTURE = [
  "COMMAND   PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME",
  "node    12345 ilona   23u  IPv4 0x1a2b3c4d5e6f      0t0  TCP *:3000 (LISTEN)",
  "node    12345 ilona   24u  IPv6 0x1a2b3c4d5e70      0t0  TCP [::1]:3000 (LISTEN)",
  "python  23456 ilona    5u  IPv4 0xdeadbeef          0t0  TCP 127.0.0.1:8000 (LISTEN)",
  "node    12345 ilona   25u  IPv4 0x1a2b3c4d5e71      0t0  TCP 127.0.0.1:52644->127.0.0.1:8000 (ESTABLISHED)",
  "not even close to an lsof line",
  "",
].join("\n");

test("parseLsof extracts LISTEN rows and keeps the printed address", () => {
  assert.deepEqual(parseLsof(LSOF_FIXTURE), [
    { port: 3000, pid: 12345, address: "*" },
    { port: 3000, pid: 12345, address: "[::1]" },
    { port: 8000, pid: 23456, address: "127.0.0.1" },
  ]);
});

test("parseLsof returns nothing for empty or header-only output", () => {
  assert.deepEqual(parseLsof(""), []);
  assert.deepEqual(
    parseLsof("COMMAND   PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME\n"),
    [],
  );
});

const NETSTAT_FIXTURE = [
  "",
  "Active Connections",
  "",
  "  Proto  Local Address          Foreign Address        State           PID",
  "  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       4321",
  "  TCP    127.0.0.1:52644        127.0.0.1:8000         ESTABLISHED     8765",
  "  TCP    [::]:3000              [::]:0                 LISTENING       4321",
  "  UDP    0.0.0.0:5353           *:*                                    1111",
  "",
].join("\r\n");

test("parseNetstat keeps only TCP LISTENING rows", () => {
  assert.deepEqual(parseNetstat(NETSTAT_FIXTURE), [
    { port: 3000, pid: 4321, address: "0.0.0.0" },
    { port: 3000, pid: 4321, address: "[::]" },
  ]);
});

test("parseNetstat survives garbage and empty input", () => {
  assert.deepEqual(parseNetstat(""), []);
  assert.deepEqual(parseNetstat("TCP\nTCP nonsense\n  TCP  x  y  LISTENING  notapid\n"), []);
});

const PROC_TCP_FIXTURE = [
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
  "   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 123456 1 0000000000000000 100 0 0 10 0",
  "   1: 0100007F:1F40 00000000:0000 01 00000000:00000000 00:00000000 00000000  1000        0 234567 1 0000000000000000 100 0 0 10 0",
  "   2: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 345678 1 0000000000000000 100 0 0 10 0",
  "   3: 0100007F:1F91 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 999999 1 0000000000000000 100 0 0 10 0",
  "",
].join("\n");

test("parseProcNetTcp keeps LISTEN rows with a known inode", () => {
  const inodeToPid = new Map([
    ["123456", 42],
    ["345678", 43],
    // 234567 belongs to the ESTABLISHED row; 999999 is deliberately absent.
  ]);
  assert.deepEqual(parseProcNetTcp(PROC_TCP_FIXTURE, inodeToPid), [
    { port: 3000, pid: 42, address: "0.0.0.0" }, // 0x0BB8, wildcard v4
    { port: 8080, pid: 43, address: "127.0.0.1" }, // little-endian 0100007F
  ]);
});

test("parseProcNetTcp decodes tcp6 wildcard as ::", () => {
  const tcp6 = [
    "  sl  local_address                         rem_address                           st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 00000000000000000000000000000000:1F40 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 777 1 0000000000000000 100 0 0 10 0",
    "",
  ].join("\n");
  assert.deepEqual(parseProcNetTcp(tcp6, new Map([["777", 55]])), [
    { port: 8000, pid: 55, address: "::" },
  ]);
});

test("parsePsTree tolerates ragged whitespace and skips the header", () => {
  const map = parsePsTree("  PID  PPID\n    1     0\n  345      1\n\t9999\t345\nnot a row\n");
  assert.deepEqual(
    map,
    new Map([
      [1, 0],
      [345, 1],
      [9999, 345],
    ]),
  );
});

test("descendantsOf returns roots plus all transitive children", () => {
  // 100 → 200 → 300, 100 → 201; 500 → 501 is an unrelated branch.
  const parents = new Map([
    [200, 100],
    [201, 100],
    [300, 200],
    [501, 500],
  ]);
  const result = descendantsOf([100], parents).sort((a, b) => a - b);
  assert.deepEqual(result, [100, 200, 201, 300]);
});

test("descendantsOf includes roots that have no known children", () => {
  assert.deepEqual(descendantsOf([7], new Map()), [7]);
});

test("descendantsOf terminates on a pid cycle without duplicates", () => {
  const parents = new Map([
    [2, 1],
    [1, 2], // corrupt: 1 and 2 claim each other
    [3, 2],
  ]);
  const result = descendantsOf([1], parents).sort((a, b) => a - b);
  assert.deepEqual(result, [1, 2, 3]);
});
