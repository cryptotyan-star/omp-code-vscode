import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const service = fs.readFileSync(path.join(root, "src/remoteControlService.ts"), "utf8");
const extension = fs.readFileSync(path.join(root, "src/extension.ts"), "utf8");
const session = fs.readFileSync(path.join(root, "src/ompSession.ts"), "utf8");

test("remote restore is invoked at activation and retried after the first session appears", () => {
  assert.match(extension, /remoteControl\.restore\(\)/);
  assert.match(service, /if \(!sessions\.length\)\s*\{\s*this\.restoreDeferred = true;/);
  assert.match(service, /this\.restoreDeferred && !this\.restoreInProgress[\s\S]*?this\.restore\(\)/);
});

test("network commands enter only the strict OmpSession dispatcher", () => {
  assert.match(service, /parseDeviceControlFrame\(plaintext\)/);
  assert.match(service, /target\.handleRemoteCommand\(command, attachments\)/);
  assert.doesNotMatch(service, /proc\.(?:send|request)\(command/);
});

test("prompt attachments survive RPC acceptance and are released only at agent_end", () => {
  assert.doesNotMatch(service, /handleRemoteCommand\(command, attachments\)[\s\S]{0,160}consumeCommittedAttachments/);
  assert.match(service, /frame\?\.type === "agent_end"[\s\S]*consumeCommittedAttachments/);
  assert.match(service, /!inUse\.has\(id\)[\s\S]*DEFAULT_ATTACHMENT_CLEANUP_MS/);
});

test("remote credentials cannot create arbitrary SecretStorage keys", () => {
  assert.match(service, /if \(!provider\) throw new Error\("provider is not in the desktop credential allowlist"\)/);
  assert.doesNotMatch(service, /provider\?\.secret \?\? `ompcode\.providerKey/);
});

test("all-session grant refreshes only sessions inside frozen canonical roots", () => {
  assert.match(service, /refreshScopedSessions\(\)/);
  assert.match(service, /requireCanonicalRemotePath\(session\.remoteWorkspaceRoot, secrets\.scope\.workspaceRoots\)/);
  assert.match(service, /secrets\.scope\.sessionIds = nextIds/);
});

test("current-session restore fails closed when its exact ephemeral id is absent", () => {
  const remap = service.slice(service.indexOf("private async remapScopeToLiveSessions"), service.indexOf("private refreshScopedSessions"));
  assert.match(remap, /selectRestoredRemoteSessionIds\([\s\S]*secrets\.scope\.sessionIds/);
  assert.doesNotMatch(remap, /inside\.slice\(0, 1\)/);
  assert.match(service, /if \(!restoredScope\) \{[\s\S]*revokeUnrestorableStoredEpoch\(stored\)[\s\S]*requires pairing/);
});

test("hello cannot claim a future event ACK and timeout forces reconnect", () => {
  assert.match(service, /claimedHighWater <= durableHighWater/);
  assert.match(service, /hello\.hostGeneration === secrets\.hostGeneration/);
  assert.match(service, /sequence > connection\.highestSentEventSequence/);
  assert.match(service, /onEventAckTimeout[\s\S]*forceReconnect/);
});

test("old-generation replay resolves an exact recovered command before generation rejection", () => {
  const generationCheck = service.indexOf('if (command.hostGeneration !== secrets.hostGeneration)');
  const durableLookup = service.indexOf('findExactDurableCommand(durable.commands', generationCheck);
  const storedAck = service.indexOf('this.sendStoredCommandAck(peerId, command, previous)', durableLookup);
  const generationReject = service.indexOf('"wrong-generation"', storedAck);
  assert.ok(generationCheck >= 0 && durableLookup > generationCheck);
  assert.ok(storedAck > durableLookup && generationReject > storedAck);
  assert.match(service.slice(generationCheck, generationReject), /counter: command\.commandCounter[\s\S]*digest: commandDigest/);
});

test("SecretStorage mutations share the same ordered snapshot writer", () => {
  assert.match(service, /secretWriter = new OrderedSnapshotWriter<string \| undefined>/);
  assert.match(service, /this\.secretWriter\.enqueue\(snapshot/);
  assert.doesNotMatch(service, /await this\.context\.secrets\.delete\(SECRET_KEY\)/);
});

test("a continuously connected device receives signed capability refresh events", () => {
  assert.match(service, /scheduleCapabilityRefresh\(\)/);
  assert.match(service, /queueEvent\("capability-update"/);
  assert.match(service, /capabilitySignature: device\.capabilitySignature/);
});

test("large private command results are streamed atomically before a small terminal marker", () => {
  assert.match(service, /planRemoteCommandResult\(command\.commandId, randomUUID\(\), rawResult\)/);
  assert.match(service, /await this\.sendCommandResultStream\(peerId, command, resultPlan\.packets, resultPlan\.marker\)/);
  assert.match(service, /this\.eventQueue\.enqueue\(async \(\) => \{[\s\S]*makeEventFrame\("command-result"[\s\S]*await finalAck[\s\S]*makeCommandAck\(command, "completed", marker\)/s);
  assert.match(service, /const result = resultPlan\.kind === "inline" \? resultPlan\.result : resultPlan\.marker/);
  assert.doesNotMatch(service, /boundedJson\(await this\.executeCommand/);
  const settled = service.indexOf("terminalSettled = true;");
  const streamed = service.indexOf("await this.sendCommandResultStream(peerId, command, resultPlan.packets, resultPlan.marker);");
  assert.ok(settled >= 0 && streamed > settled);
  assert.match(service, /else if \(resultPlan\.kind === "inline"\) \{\s*this\.sendCommandAck/);
  assert.match(service, /status === "completed" && cached[\s\S]*sendCommandResultStream[\s\S]*cached\.marker/);
  assert.match(service, /"indeterminate"[\s\S]*"result-unavailable"/);
  assert.match(service, /result: isStreamedCommandResultMarker\(record\.result\) \? record\.result : undefined/);
});

test("remote self-revoke destroys durable authority before its completed ACK", () => {
  const admission = service.slice(service.indexOf("private async processCommand"), service.indexOf("private scheduleRemoteCommandTask"));
  const begin = admission.indexOf("this.revocationAdmission.begin();");
  const commit = admission.indexOf("await this.commitActiveRevocation();");
  const persistAccepted = admission.indexOf("await this.persistDurable();");
  const acceptedAck = admission.indexOf('this.sendCommandAck(peerId, command, "accepted");');
  assert.ok(begin >= 0 && commit > begin && persistAccepted > commit && acceptedAck > persistAccepted);
  const execution = service.slice(service.indexOf("private async executeAcceptedCommand"), service.indexOf("private async executeCommand"));
  assert.ok(execution.indexOf("sendCommandAckAndFlush") < execution.indexOf("await this.stop(true)"));
  assert.doesNotMatch(execution, /setTimeout/);
  assert.match(service, /isRemoteEpochRevoked\(stored\.keyEpoch, revokedThroughEpoch\)/);
  assert.match(service, /if \(this\.revocationCommitted\) return this\.deleteSecrets\(\)/);
  assert.match(service, /if \(this\.revocationAdmission\.active\)[\s\S]*"revocation-in-progress"/);
});

test("priority approval and abort lanes bypass long per-session commands after durable admission", () => {
  assert.match(service, /this\.commandScheduler\.admit\([\s\S]*this\.processCommand/);
  assert.match(service, /command\.command === "approval\.respond" \|\| command\.command === "turn\.abort"[\s\S]*\? "control"/);
  assert.match(service, /await this\.persistDurable\(\); \/\/ atomic accept boundary before ordinary side effects[\s\S]*this\.scheduleRemoteCommandTask/);
  assert.doesNotMatch(service, /commandQueue\.then/);
});

test("desktop and remote approvals share one claim-before-send path and mirror the winner", () => {
  assert.match(session, /case "uiResponse"[\s\S]*this\.deliverApprovalResponse\(msg\.frame as Record<string, unknown>, "desktop"\)/);
  assert.match(session, /handleRemoteApproval[\s\S]*return this\.deliverApprovalResponse\(frame, "remote"\)/);
  const delivery = session.slice(session.indexOf("private deliverApprovalResponse"), session.indexOf("showHistory(): void"));
  assert.ok(delivery.indexOf("claimPendingApproval") < delivery.indexOf("proc.send(frame)"));
  assert.match(delivery, /t: "approvalResolved", requestId, outcome, winner/);
  assert.match(service, /command\.command === "approval\.respond"[\s\S]*"host-not-pending"/);
});

test("credential status sync contains booleans and provider metadata, never values", () => {
  assert.match(service, /verbs\.includes\("credentials\.manage"\)[\s\S]*remoteKeyStatus\(\)/);
  assert.match(service, /keys\[provider\.id\] = Boolean\(await this\.context\.secrets\.get\(provider\.secret\)\)/);
  assert.doesNotMatch(service, /remoteKeyStatus[\s\S]{0,900}value:\s*await this\.context\.secrets\.get/);
});

test("an expired two-phase enrolment cannot activate and is revoked by timer", () => {
  assert.match(service, /pending enrolment expired before acknowledgement/);
  assert.match(service, /schedulePairingExpiry\(\)/);
  assert.match(service, /secrets\.pairingExpiresAt <= Date\.now\(\)[\s\S]*this\.stop\(true\)/);
});

test("only the globalState host-lease owner opens the relay transport", () => {
  assert.match(service, /new RemoteHostLease\(context\.globalState\)/);
  const restore = service.slice(service.indexOf("async restore()"), service.indexOf("async start("));
  assert.match(restore, /if \(await this\.acquireHostLease\(\)\) \{\s*this\.openTransport\(\)/);
  assert.match(restore, /\} else \{[\s\S]*this\.scheduleHostRetry\(\)/);
  const start = service.slice(service.indexOf("async start("), service.indexOf("async stop("));
  assert.ok(start.indexOf("if (!(await this.acquireHostLease()))") < start.indexOf("await this.stop(true)"));
  assert.match(start, /if \(await this\.acquireHostLease\(\)\) \{\s*this\.openTransport\(\)/);
  const stop = service.slice(service.indexOf("async stop("), service.indexOf("async refreshPairing("));
  assert.match(stop, /await this\.hostLease\.release\(\)/);
  const dispose = service.slice(service.indexOf("dispose(): void"), service.indexOf("private async acquireHostLease"));
  assert.match(dispose, /this\.hostLease\.stopHeartbeat\(\)[\s\S]*this\.hostLease\.release\(\)/);
  const retry = service.slice(service.indexOf("private async retryHostAcquisition"), service.indexOf("private openTransport"));
  assert.match(retry, /await this\.hostLease\.tryAcquire\(\)[\s\S]*await this\.readSecrets\(\)[\s\S]*isRemoteEpochRevoked/);
  assert.equal(service.match(/this\.openTransport\(\);/g)?.length, 3, "every transport open stays behind a lease guard");
});
