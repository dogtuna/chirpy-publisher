Place sidecar binaries here for desktop packaging.

Expected layout:

- `resources/bin/darwin-arm64/ipfs`
- `resources/bin/darwin-arm64/ollama`
- `resources/bin/darwin-x64/ipfs`
- `resources/bin/darwin-x64/ollama`
- `resources/bin/linux-x64/ipfs`
- `resources/bin/linux-x64/ollama`
- `resources/bin/win32-x64/ipfs.exe`
- `resources/bin/win32-x64/ollama.exe`

During build, `electron-builder` copies this folder into app `extraResources/bin`.
