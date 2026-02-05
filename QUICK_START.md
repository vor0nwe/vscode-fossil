# Quick Start: Using Stash as Staging Area

This guide will get you started with the new stash-as-staging-area feature in 2 minutes.

## What's New?

You can now save your staging area to named Fossil stashes and load them back later. This is useful for:
- Managing multiple features simultaneously
- Preserving different sets of changes
- Switching between different work contexts

## Basic Workflow

### 1. Save Your Staged Changes to a Stash

```
1. Make changes to files
2. Stage them (click + icon)
3. Open Command Palette (Ctrl+Shift+P / Cmd+Shift+P)
4. Run: "Fossil: Stash Stage (Save Staging Area)"
5. Enter a name like "feature-login" or accept default
```

Your staged changes are now saved as a stash, and the staging area is cleared.

### 2. Load a Stash into Staging

```
1. Open Command Palette
2. Run: "Fossil: Stash Load into Staging"
3. Select the stash you want to work on
```

The stash is applied and all files are staged, ready for you to continue working or commit.

### 3. Combine Multiple Stashes

```
1. Load first stash: "Stash Load into Staging"
2. Add more changes: "Stash Apply to Staging"
3. Commit all staged changes together
```

## Menu Access

All commands are also available in the Source Control panel:
```
Source Control → ... (menu) → Stash → [Your Command]
```

## Example Scenario

**Working on Two Features:**

```bash
# Work on feature A
- Edit file1.js, file2.js
- Stage both files
- Save to stash: "feature-a"

# Switch to feature B
- Edit file3.js, file4.js
- Stage both files
- Save to stash: "feature-b"

# Finish feature A first
- Load stash "feature-a"
- Review changes
- Commit

# Then finish feature B
- Load stash "feature-b"
- Commit
```

## Commands Summary

| Command | What It Does |
|---------|-------------|
| **Stash Stage** | Save staging area to named stash (clears staging) |
| **Stash Load into Staging** | Load stash into staging (replaces current) |
| **Stash Apply to Staging** | Add stash to staging (keeps current staged files) |

## Tips

- Use descriptive stash names: "feature-login", "bugfix-123", etc.
- The staging area is still virtual - stashes are the persistent storage
- Stashes created this way are regular Fossil stashes
- You can still use traditional stash commands (Pop, Apply, Drop)

## Need Help?

- See `MANUAL_TESTING.md` for detailed test scenarios
- See `IMPLEMENTATION_SUMMARY.md` for technical details
- Check the main README for general usage information
