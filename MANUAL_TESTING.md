# Manual Testing Guide: Stash as Staging Area Feature

This guide provides step-by-step instructions for manually testing the new stash-as-staging-area feature.

## Prerequisites

1. VS Code with the Fossil extension installed
2. Fossil SCM installed and accessible in PATH
3. A Fossil repository opened in VS Code

## Test Scenarios

### Scenario 1: Save Staging Area to Stash

**Purpose:** Verify that staged changes can be saved to a named stash and the staging area is cleared.

**Steps:**
1. Make changes to one or more files in your repository
2. Stage the changes using the "+" button in the Source Control panel
3. Verify files appear in the "Staged Changes" section
4. Open Command Palette (Ctrl+Shift+P / Cmd+Shift+P)
5. Run command: `Fossil: Stash Stage (Save Staging Area)`
6. Enter a descriptive stash message (or accept the default)
7. Verify:
   - The stash was created successfully
   - The "Staged Changes" section is now empty
   - Files remain in the "Changes" section

**Expected Result:** Staged changes are saved to a stash with the given name, and the staging area is cleared.

---

### Scenario 2: Load Stash into Staging Area

**Purpose:** Verify that a stash can be loaded into the staging area, replacing current staged changes.

**Steps:**
1. Create a stash using "Stash Stage" command (see Scenario 1)
2. Make different changes to other files and stage them
3. Open Command Palette
4. Run command: `Fossil: Stash Load into Staging`
5. Select the stash you created in step 1
6. Verify:
   - Previous staged changes are cleared
   - Files from the selected stash are now in the "Staged Changes" section
   - Files appear in working directory with the stashed changes

**Expected Result:** The stash is applied and all modified files are staged, replacing any previously staged changes.

---

### Scenario 3: Apply Stash to Staging (Additive)

**Purpose:** Verify that a stash can be applied to the staging area while keeping existing staged changes.

**Steps:**
1. Create two stashes using "Stash Stage" command with different files
2. Stage some files manually
3. Open Command Palette
4. Run command: `Fossil: Stash Apply to Staging`
5. Select one of the stashes
6. Verify:
   - Previously staged files remain staged
   - Files from the selected stash are also now staged
   - All staged files appear in the "Staged Changes" section

**Expected Result:** The stash is applied additively, and both previous and new changes are staged together.

---

### Scenario 4: No Staged Changes Warning

**Purpose:** Verify that attempting to save an empty staging area shows a warning.

**Steps:**
1. Ensure the "Staged Changes" section is empty
2. Open Command Palette
3. Run command: `Fossil: Stash Stage (Save Staging Area)`
4. Verify:
   - A warning message appears: "No staged changes to stash"
   - No stash is created

**Expected Result:** User is warned when trying to stash an empty staging area.

---

### Scenario 5: Multiple Stashes as Staging Areas

**Purpose:** Verify the workflow of maintaining multiple sets of changes as named stashes.

**Steps:**
1. Make changes to files A and B, stage them
2. Save to stash named "feature-1" using "Stash Stage"
3. Make changes to files C and D, stage them
4. Save to stash named "feature-2" using "Stash Stage"
5. Load "feature-1" stash into staging
6. Verify files A and B are staged
7. Load "feature-2" stash into staging
8. Verify files C and D are staged (replacing A and B)
9. Commit the staged changes
10. Load "feature-1" again and commit

**Expected Result:** Users can maintain multiple independent sets of changes as named stashes and switch between them easily.

---

### Scenario 6: Menu Integration

**Purpose:** Verify that commands are accessible from the SCM menu.

**Steps:**
1. Open the Source Control panel
2. Click the "..." menu button
3. Navigate to the "Stash" submenu
4. Verify the following commands are present:
   - Stash Snapshot
   - Stash Push
   - Stash Pop
   - Stash Apply
   - Stash Drop
   - Stash Stage (Save Staging Area)
   - Stash Load into Staging
   - Stash Apply to Staging

**Expected Result:** All stash-related commands are accessible from the SCM menu.

---

## Regression Testing

Ensure existing functionality still works:

1. **Stash Save/Snapshot:** Can still create stashes the traditional way
2. **Stash Pop:** Can apply and remove most recent stash
3. **Stash Apply:** Can apply a stash without removing it
4. **Stash Drop:** Can delete a stash
5. **Stage/Unstage:** Standard staging operations work as before
6. **Commit Staged:** Can commit only staged changes

## Notes

- The staging area in this extension is virtual (not persisted by Fossil itself)
- Stashes created with "Stash Stage" are regular Fossil stashes
- The feature works by combining Fossil's stash functionality with the extension's staging mechanism
