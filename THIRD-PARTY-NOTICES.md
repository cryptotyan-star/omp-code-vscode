# Third-party notices

OMP Code is MIT-licensed (see `LICENSE`). Two kinds of third-party work ship
in this extension, and both are listed here in full.

## Bundled runtime dependencies

`package.json` declares three runtime dependencies — `qrcode`, `ws` and
`yaml`. esbuild compiles them into `dist/extension.js` (licence comments
preserved via `legalComments: "eof"`), so the `.vsix` distributes their code
even though no `node_modules` folder is shipped. Everything else in
`devDependencies` (TypeScript, esbuild, `@types/*`, `@vscode/vsce`) is
build-time only and is not distributed.

| Package | Version | Used for | Licence |
| --- | --- | --- | --- |
| [qrcode](https://github.com/soldair/node-qrcode) | ^1.5.4 | the Remote Control pairing QR | MIT |
| [ws](https://github.com/websockets/ws) | ^8.21.3 | the relay WebSocket transport | MIT |
| [yaml](https://github.com/eemeli/yaml) | ^2.4.5 | reading the omp CLI's `models.yml` | ISC |

## Derived code

Parts of the git-worktree layer under `src/workspaces/` are derived from the
projects listed below rather than written from scratch — worktree plumbing and
merge sequencing are full of stderr shapes, porcelain quirks and orderings
that these projects already found and fixed. Each derived file repeats its
attribution in a header comment, so the credit survives bundling; this file
carries the full licence texts. The code was copied, trimmed to node built-ins
and adapted; the upstream projects are not shipped.

| Project | Used for | Licence |
| --- | --- | --- |
| [microsoft/vscode](https://github.com/microsoft/vscode) (`extensions/git`) | stderr → error-code classification for `git worktree` and for merging (`MergeConflict`, `NoFastForward`, `LocalChangesOverwritten`, `StashConflict`, `UnmergedFiles`), the `worktree add`/`remove` argument builders, `rev-parse --git-dir/--git-common-dir` repository resolution, and the default worktree path scheme `<repo parent>/<repo name>.worktrees/<branch>` | MIT |
| [jackiotyu/git-worktree-manager](https://github.com/jackiotyu/git-worktree-manager) | the `git worktree list --porcelain` parser (bare / detached / locked / prunable / main), the spawn wrapper around git, and ahead/behind counting via `rev-list --left-right --count` | MIT |
| [stravu/crystal](https://github.com/stravu/crystal) | the named async mutex that serialises writes per repository, the plumbing-level dirty check (`update-index --refresh`, `diff-files`, `diff-index --cached`, `ls-files --others`), the `--numstat` parser and change categories behind the review diff, and the ordering that makes a squash merge safe — rebase the worktree, `rebase --abort` on conflict, `reset --soft` to the merge base, one commit, then `merge --ff-only` in the main checkout | MIT |

---

# Bundled runtime dependency licences

## qrcode (MIT)

The MIT License (MIT)

Copyright (c) 2012 Ryan Day

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## ws (MIT)

Copyright (c) 2011 Einar Otto Stangvik <einaros@gmail.com>
Copyright (c) 2013 Arnout Kazemier and contributors
Copyright (c) 2016 Luigi Pinca and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## yaml (ISC)

Copyright Eemeli Aro <eemeli@gmail.com>

Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

---

# Derived-code licences

## microsoft/vscode

MIT License

Copyright (c) 2015 - present Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## jackiotyu/git-worktree-manager

MIT License

Copyright (c) 2023-2026 BingFeng Huang

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## stravu/crystal

MIT License

Copyright (c) 2024 Stravu

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
