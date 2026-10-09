# October 9 workspace incorporation

The October 9 export contains 36 source records: 26 unchanged archive records already built into Life 0.6, plus 10 new enabled extensions. There are no runtime extensions. The new extensions compose 49 ordered file changes into 30 final source files, including 21 new files.

Every existing file's first patch preimage matches the Life 0.6 source after normalizing Windows newlines. Applying the final ordered snapshots preserves the existing project, transport and emergency-recovery fixes. The application then builds from those sources, without replaying the exported patches at startup.

| New extension         | Incorporated behavior                                                          | Main sources                                                                             |
| --------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `source-291e3f4359ea` | Compact user messages, square attachments, removal buttons and upload progress | `MessageView`, `ThreadAttachments`, attachment layout styles                             |
| `source-265a22e310cd` | Compact source-change receipts and distinct project colors                     | `LifeSourceCard`, `ProjectColors`, `source-presentation`, `ThreadBadge`                  |
| `source-ee937ac6bc82` | Project map, Research goals and problem workspaces                             | `LifeMap`, `GraphCanvas`, `ResearchWorkbench`, `workbench`                               |
| `source-12cfab44e306` | Header view controls with consistent spacing                                   | `TitleBar`, header view styles                                                           |
| `source-2b3a5bff463a` | Claude's terracotta logo color                                                 | `Icons`                                                                                  |
| `source-2f6848a57686` | Persistent Research map and resizable conversation sidebar                     | `ResearchLayout`, `ResearchWorkbench`, `SidebarResize`                                   |
| `source-deac6139f1b6` | Research divider aligned through the title bar                                 | `ResearchLayout`, research layout styles                                                 |
| `source-9d9f38a237da` | One New goal control and corrected creation dialog                             | `ResearchWorkbench`, research goal styles                                                |
| `source-60cf7584c344` | Machine-backed Research, editable maps, saved drafts, filters and sorting      | `research-files`, `ResearchEditableMap`, `ResearchSidebarFilters`, `conversation-drafts` |
| `source-3ed4505f113d` | Built-in feature enable, disable and delete controls                           | `builtin-extensions`, `ExtensionDialog`                                                  |

All dependencies requested by these extensions already exist in the application dependency list. Further behavior changes requested alongside the export take precedence over older exported behavior, including Research isolation and storage, a dedicated customization workspace, and unchanged user messages sent to providers.

The public incorporation manifest contains only 37 historical extension IDs and complete-bundle SHA256 hashes: all 27 earlier identities and all 10 new identities. The older export-all-backup identity remains recognized even though its archive record is absent from the latest export. Source snapshots, backup payloads and machine-specific paths are not included in this manifest.

Private migration checks against both complete exports verify that all 36 October 9 bundles and all 27 October 8 bundles become recognized, exportable archives. They preserve the original generation and recovery state, use current built-in source, produce no old custom assets or startup error, and remain unchanged on the next restart. The incorporation unit tests also verify exact bundle matching and preserve modified or unrelated extensions for adaptation.
