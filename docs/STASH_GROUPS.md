# Stash Groups Feature

## Overview

This feature displays each Fossil stash as a separate resource group in the VS Code Source Control sidebar, similar to how "Staged Changes", "Changes", and "Untracked Files" are displayed.

## User Experience

### Before
Stashes were only accessible through commands:
- `Fossil: Stash Save`
- `Fossil: Stash Apply`
- `Fossil: Stash Pop`
- etc.

Users had to remember what was in each stash or run commands to see the contents.

### After
Each stash now appears as an expandable group in the SCM sidebar:
```
Source Control
├── Staged Changes (2)
├── Changes (3)
├── Untracked Files (1)
├── Stash 1: feature work in progress (4)
│   ├── src/file1.ts
│   ├── src/file2.ts
│   ├── src/file3.js
│   └── README.md
└── Stash 2: bugfix for issue #123 (2)
    ├── src/components/Button.tsx
    └── src/styles/button.css
```

### Benefits
- **Visual Overview**: See all stashes and their contents at a glance
- **Quick Access**: Click to view file diffs directly from stash groups
- **Context Awareness**: Know what changes are in each stash without running commands
- **Better Organization**: Stashes displayed alongside other file groups for unified workflow

## Technical Implementation

### Architecture

```
┌─────────────────────────────────────────────────┐
│           VS Code SCM UI                         │
│  ┌───────────────────────────────────────────┐  │
│  │ Static Groups (always present)            │  │
│  │  - Conflict                               │  │
│  │  - Staging                                │  │
│  │  - Working                                │  │
│  │  - Untracked                              │  │
│  └───────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────┐  │
│  │ Dynamic Stash Groups (created on-demand)  │  │
│  │  - Stash 1: [message]                     │  │
│  │  - Stash 2: [message]                     │  │
│  │  - ...                                    │  │
│  └───────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
                     ▲
                     │
        ┌────────────┴────────────┐
        │   StashGroupManager     │
        │  - updateStashGroups()  │
        │  - formatStashLabel()   │
        │  - dispose()            │
        └────────────┬────────────┘
                     │
        ┌────────────┴────────────┐
        │    Repository           │
        │  - updateStatus()       │
        │  - updateStashGroups()  │
        └────────────┬────────────┘
                     │
        ┌────────────┴────────────┐
        │  OpenedRepository       │
        │  - stashList()          │
        │  - stashFiles()         │
        └─────────────────────────┘
                     │
                     ▼
              ┌──────────────┐
              │    Fossil    │
              │   stash list │
              │   stash diff │
              └──────────────┘
```

### Key Components

#### 1. `stashFiles()` Method (openedRepository.ts)
```typescript
async stashFiles(stashId: StashID): Promise<StashFile[]>
```
- Executes `fossil stash diff [stashId]`
- Parses diff output to extract file paths
- Returns array of `StashFile` objects with path and status

#### 2. `StashGroupManager` Class (resourceGroups.ts)
```typescript
class StashGroupManager {
    private stashGroups: Map<StashID, FossilResourceGroup>;
    
    updateStashGroups(
        stashes: StashItem[],
        stashFilesMap: Map<StashID, StashFile[]>,
        repositoryRoot: FossilRoot
    ): void;
}
```
- Manages lifecycle of dynamic stash groups
- Creates new groups for new stashes
- Updates existing groups when stashes change
- Disposes groups for deleted stashes
- Formats labels as "Stash N: [comment]"

#### 3. Repository Integration (repository.ts)
```typescript
private _stashGroupManager: StashGroupManager;

private async updateStashGroups(): Promise<void> {
    const stashes = await this.repository.stashList();
    const stashFilesMap = new Map<StashID, StashFile[]>();
    for (const stash of stashes) {
        const files = await this.repository.stashFiles(stash.stashId);
        stashFilesMap.set(stash.stashId, files);
    }
    this._stashGroupManager.updateStashGroups(stashes, stashFilesMap, this.repository.root);
}
```
- Integrated into `updateStatus()` lifecycle
- Queued with `@queue('queue', 's')` to prevent database locks
- Called after file status updates

### Update Flow

1. User action triggers status update (save file, run command, etc.)
2. `Repository.updateStatus()` executes
3. Regular file status groups updated (staging, working, etc.)
4. `updateStashGroups()` called
5. `stashList()` fetches all stashes
6. For each stash, `stashFiles()` fetches file list
7. `StashGroupManager.updateStashGroups()` creates/updates groups
8. VS Code SCM UI automatically reflects changes

### Performance Considerations

#### Current Implementation
- Stash groups update on every status refresh
- Each stash requires a `fossil stash diff` call
- Could be slow with many stashes

#### Optimization Opportunities (Future)
1. **Lazy Loading**: Only fetch files when group is expanded
2. **Caching**: Cache stash file lists, invalidate on stash operations
3. **Debouncing**: Throttle updates during rapid file changes
4. **Pagination**: Limit number of visible stashes
5. **Configuration**: Add option to disable stash groups

## Fossil Commands Used

### `fossil stash list`
Returns list of all stashes with:
- Stash ID (number)
- Hash
- Date
- Comment/message

Example output:
```
  1: [abc123] on 2024-01-15 10:30:00
     Feature work in progress
  2: [def456] on 2024-01-14 15:20:00
     Bugfix for issue #123
```

### `fossil stash diff [STASHID]`
Returns unified diff showing changes in the specified stash.

Example output:
```
--- a/src/file1.ts
+++ b/src/file1.ts
@@ -10,5 +10,6 @@
 function example() {
+    // new code
 }
--- a/src/file2.ts
+++ b/src/file2.ts
...
```

The extension parses the `--- a/` and `+++ b/` headers to extract file paths.

## Future Enhancements

### Potential Features
1. **Context Menu Actions**
   - Apply stash (right-click on stash group)
   - Drop stash
   - View full stash diff
   - Create branch from stash

2. **File Decorations**
   - Show file status icons (modified, added, deleted)
   - Color coding based on change type

3. **Stash Management**
   - Rename stash comments
   - Reorder stashes
   - Compare stashes

4. **Performance**
   - Lazy load file lists
   - Cache stash contents
   - Virtual scrolling for many stashes

5. **UI Polish**
   - Custom stash group icons
   - Collapse/expand all stashes
   - Filter stashes by age/message

## Testing

### Manual Testing Steps
1. Install extension in VS Code
2. Open a Fossil repository
3. Make changes to files
4. Create a stash: `Fossil: Stash Save`
5. Verify stash group appears in SCM sidebar
6. Expand stash group to see files
7. Create another stash
8. Verify both stashes visible
9. Apply/drop a stash
10. Verify stash group disappears

### Automated Tests (TODO)
- Unit tests for `stashFiles()` parsing
- Unit tests for StashGroupManager
- Integration tests for repository updates
- UI tests for group visibility

## Configuration

Currently no configuration options. Future possibilities:
- `fossil.showStashGroups`: Enable/disable feature
- `fossil.maxVisibleStashes`: Limit number of stashes shown
- `fossil.stashGroupPosition`: "top" | "bottom" | "after-changes"

## Compatibility

- **Minimum Fossil Version**: Any version with `stash list` and `stash diff` commands
- **Minimum VS Code Version**: 1.36.0 (same as extension)
- **Operating Systems**: All platforms (Windows, macOS, Linux)

## Known Limitations

1. **File Status Detection**: Currently all files marked as MODIFIED
   - Future: Detect ADD, DELETE, RENAME from diff output
2. **Large Stashes**: No pagination or lazy loading yet
3. **Performance**: Updates on every status refresh
4. **No Nested Groups**: Can't group stashes by date/branch
5. **Limited Actions**: No context menu actions yet

## References

- [VS Code SCM API](https://code.visualstudio.com/api/extension-guides/scm-provider)
- [Fossil Stash Documentation](https://fossil-scm.org/home/help?cmd=stash)
- [Extension Architecture](../README.md)
