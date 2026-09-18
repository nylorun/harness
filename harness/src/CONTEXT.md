# Harness source

A definition is assembled. Execution owns progress. A step is one model call. Compiled pieces stay next to the phase that owns them; `package.json` exports, not folder names, keep them off the public package.

| Folder             | Job                                                                       |
| ------------------ | ------------------------------------------------------------------------- |
| `types/`           | Public contracts for callers and adapters                                 |
| `definition/`      | Assemble a definition: capabilities, tools, output contract, `BuiltAgent` |
| `execution/`       | One `run()` invocation: resume, record, dispatch, settle                  |
| `execution/step/`  | One model call: middleware, request, seal                                 |
| `execution/model/` | Normalize candidates and project a portable model call                    |
| `utils/`           | Shared JSON and identity helpers                                          |

`Agent(...).use(...).build()` retains definitions only. `run({ state, input, onModelCall })` is a new invocation each time; supplied state is never mutated.
