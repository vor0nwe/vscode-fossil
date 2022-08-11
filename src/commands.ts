/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Ben Crowl. All rights reserved.
 *  Original Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
    Uri,
    commands,
    Disposable,
    window,
    workspace,
    OutputChannel,
    SourceControlResourceState,
    SourceControl,
    SourceControlResourceGroup,
    TextDocumentShowOptions,
    ViewColumn,
    Selection,
} from 'vscode';
import { LineChange, revertChanges } from './revert';
import * as nls from 'vscode-nls';
import * as path from 'path';
import {
    Fossil,
    FossilError,
    IFileStatus,
    CommitDetails,
    FossilPath,
    FossilRoot,
    FossilURI,
    FossilCheckin,
    MergeAction,
    FossilHash,
    FossilSpecialTags,
    FossilBranch,
} from './fossilBase';
import { Model } from './model';
import {
    FossilResource,
    Status,
    CommitOptions,
    CommitScope,
    MergeStatus,
    LogEntriesOptions,
    Repository,
} from './repository';
import { FossilResourceGroup, isResourceGroup } from './resourceGroups';
import {
    interaction,
    BranchExistsAction,
    WarnScenario,
    CommitSources,
    LogMenuAPI,
} from './interaction';
import { humanise } from './humanise';
import { partition } from './util';
import { toFossilUri } from './uri';

const localize = nls.loadMessageBundle();

interface Command {
    commandId: string;
    key: string;
    method: Function;
    options: CommandOptions;
}

interface CommandOptions {
    repository?: boolean;
    diff?: boolean;
}

const Commands: Command[] = [];

/**
 * Decorator
 */
function command(commandId: string, options: CommandOptions = {}): Function {
    return (
        target: CommandCenter,
        key: string,
        descriptor: PropertyDescriptor
    ) => {
        if (!(typeof descriptor.value === 'function')) {
            throw new Error('not supported');
        }

        Commands.push({ commandId, key, method: descriptor.value, options });
    };
}

export class CommandCenter {
    [index: string]: any;

    private model: Model;
    private disposables: Disposable[];

    constructor(
        private fossil: Fossil,
        model: Model,
        private outputChannel: OutputChannel
    ) {
        this.model = model;

        this.disposables = Commands.map(
            ({ commandId, key, method, options }) => {
                const command = this.createCommand(
                    commandId,
                    key,
                    method,
                    options
                );

                // if (options.diff) {
                //  return commands.registerDiffInformationCommand(commandId, command);
                // } else {
                return commands.registerCommand(commandId, command);
                // }
            }
        );
    }

    @command('fossil.refresh', { repository: true })
    async refresh(repository: Repository): Promise<void> {
        await repository.status();
    }

    @command('fossil.openResource')
    async openResource(resource: FossilResource): Promise<void> {
        await this._openResource(resource, undefined, true, false);
    }

    private async _openResource(
        resource: FossilResource | undefined,
        preview?: boolean,
        preserveFocus?: boolean,
        preserveSelection?: boolean
    ): Promise<void> {
        if (!resource) return;
        const left = this.getLeftResource(resource);
        const right = this.getRightResource(resource);
        const title = this.getTitle(resource);

        const opts: TextDocumentShowOptions = {
            preserveFocus,
            preview,
            viewColumn: ViewColumn.Active,
        };

        const activeTextEditor = window.activeTextEditor;

        // Check if active text editor has same path as other editor. we cannot compare via
        // URI.toString() here because the schemas can be different. Instead we just go by path.
        if (
            preserveSelection &&
            activeTextEditor &&
            activeTextEditor.document.uri.path === right.path
        ) {
            opts.selection = activeTextEditor.selection;
        }

        if (!left) {
            const document = await workspace.openTextDocument(right);
            await window.showTextDocument(document, opts);
            return;
        }
        return await commands.executeCommand<void>(
            'vscode.diff',
            left,
            right,
            title,
            opts
        );
    }

    private getLeftResource(resource: FossilResource): Uri | undefined {
        switch (resource.status) {
            case Status.RENAMED:
                if (resource.renameResourceUri) {
                    return toFossilUri(resource.original);
                }
                return undefined;

            case Status.ADDED:
            case Status.IGNORED:
            case Status.UNTRACKED:
            case Status.UNMODIFIED:
                return undefined;

            case Status.MODIFIED:
            case Status.CONFLICT:
            case Status.DELETED:
            case Status.MISSING:
            default:
                return toFossilUri(resource.original);
        }
    }

    private getRightResource(resource: FossilResource): Uri {
        if (
            resource.mergeStatus === MergeStatus.UNRESOLVED &&
            resource.status !== Status.MISSING &&
            resource.status !== Status.DELETED
        ) {
            return resource.resourceUri.with({ scheme: 'fossil' });
        }

        switch (resource.status) {
            case Status.DELETED:
            case Status.MISSING:
                return resource.resourceUri.with({
                    scheme: 'fossil',
                    query: 'empty',
                });

            case Status.ADDED:
            case Status.IGNORED:
            case Status.MODIFIED:
            case Status.RENAMED:
            case Status.UNTRACKED:
            case Status.UNMODIFIED:
            case Status.CONFLICT:
            default:
                return resource.resourceUri;
        }
    }

    private getTitle(resource: FossilResource): string {
        const basename = path.basename(resource.resourceUri.fsPath);
        if (
            resource.mergeStatus === MergeStatus.UNRESOLVED &&
            resource.status !== Status.MISSING &&
            resource.status !== Status.DELETED
        ) {
            return `${basename} (local <-> other)`;
        }

        switch (resource.status) {
            case Status.MODIFIED:
            case Status.ADDED:
            case Status.CONFLICT:
                return `${basename} (Working Directory)`;

            case Status.RENAMED:
                return `${basename} (Renamed)`;

            case Status.DELETED:
                return `${basename} (Deleted)`;

            case Status.MISSING:
                return `${basename} (Missing)`;
        }

        return '';
    }

    @command('fossil.clone')
    async clone(): Promise<void> {
        let url = await interaction.inputRepoUrl();
        if (!url) {
            return;
        }
        const username = await interaction.inputCloneUser();
        let userauth: string | undefined;
        if (username) {
            userauth = await interaction.inputCloneUserAuth();
        }
        if (userauth) {
            const regex =
                url.search('@') < 0 ? /(^.+:\/\/)(.+)/ : /(^.+:\/\/).*@(.+)/;
            const match = url.match(regex);
            if (match) {
                url = (match[1] +
                    username +
                    ':' +
                    userauth +
                    '@' +
                    match[2]) as FossilURI;
            }
        }
        const fossilPath = await interaction.selectNewFossilPath('Clone');
        if (!fossilPath) {
            return;
        }

        const clonePromise = this.fossil.clone(url, fossilPath);
        interaction.statusCloning(clonePromise);
        const fossilRoot = await clonePromise;
        await this.askOpenRepository(fossilPath, fossilRoot);
    }

    /**
     * Execute "fossil open". When FossilRoot has files allow to
     * run "fossil open --force"
     */
    async openRepository(
        filePath: FossilPath,
        parentPath: FossilRoot
    ): Promise<void> {
        try {
            await this.fossil.openClone(filePath, parentPath);
        } catch (err) {
            if (
                err instanceof FossilError &&
                err.fossilErrorCode === 'OperationMustBeforced'
            ) {
                const openNotEmpty = await interaction.confirmOpenNotEmpty(
                    parentPath
                );
                if (openNotEmpty) {
                    this.fossil.openCloneForce(filePath, parentPath);
                }
            } else {
                throw err;
            }
        }
    }

    /**
     * ask user to run "fossil open" after `clone` or `init`
     */
    async askOpenRepository(
        filePath: FossilPath,
        fossilRoot: FossilRoot
    ): Promise<void> {
        const openClonedRepo = await interaction.promptOpenClonedRepo();
        if (openClonedRepo) {
            await this.openRepository(filePath, fossilRoot);
            await this.model.tryOpenRepository(fossilRoot);
        }
    }

    @command('fossil.init')
    async init(): Promise<void> {
        const fossilPath = await interaction.selectNewFossilPath('Create');

        if (!fossilPath) {
            return;
        }
        const fossilRoot = path.dirname(fossilPath) as FossilRoot;
        let projectName = '';
        let projectDesc = '';
        if (this.fossil.version >= [2, 18]) {
            const userProjectName = await interaction.inputProjectName();
            if (userProjectName === undefined) {
                return;
            }
            projectName = userProjectName;

            const userProjectDesc = await interaction.inputProjectDescription();
            if (userProjectDesc === undefined) {
                return;
            }
            projectDesc = userProjectDesc;
        }

        // run init in the file folder in case any artifacts appear
        await this.fossil.init(
            fossilRoot,
            fossilPath,
            projectName,
            projectDesc
        );
        await this.askOpenRepository(fossilPath, fossilRoot);
    }

    @command('fossil.open')
    async open(): Promise<void> {
        const fossilPath = await interaction.selectExistingFossilPath();
        if (!fossilPath) {
            return;
        }
        const rootPath = await interaction.selectFossilRootPath();
        if (!rootPath) {
            return;
        }
        await this.openRepository(fossilPath, rootPath);
        await this.model.tryOpenRepository(rootPath);
    }

    @command('fossil.close', { repository: true })
    async close(repository: Repository): Promise<void> {
        return this.model.close(repository);
    }

    @command('fossil.openFiles')
    openFiles(
        ...resources: (FossilResource | SourceControlResourceGroup)[]
    ): Promise<void> {
        if (resources.length === 1) {
            // a resource group proxy object?
            const [resourceGroup] = resources;
            if (isResourceGroup(resourceGroup)) {
                // const groupId = resourceGroup.id
                const resources =
                    resourceGroup.resourceStates as FossilResource[];
                return this.openFile(...resources);
            }
        }

        return this.openFile(...(<FossilResource[]>resources));
    }

    @command('fossil.openFile')
    async openFile(...resources: FossilResource[]): Promise<void> {
        if (!resources) {
            return;
        }

        const uris = resources.map(res => res.resourceUri);
        const preview = uris.length === 1;
        const activeTextEditor = window.activeTextEditor;

        for (const uri of uris) {
            const opts: TextDocumentShowOptions = {
                preserveFocus: true,
                preview,
                viewColumn: ViewColumn.Active,
            };

            // Check if active text editor has same path as other editor. we cannot compare via
            // URI.toString() here because the schemas can be different. Instead we just go by path.
            if (
                activeTextEditor &&
                activeTextEditor.document.uri.path === uri.path
            ) {
                opts.selection = activeTextEditor.selection;
            }

            const document = await workspace.openTextDocument(uri);
            await window.showTextDocument(document, opts);
        }
    }

    @command('fossil.openChange')
    async openChange(...resources: FossilResource[]): Promise<void> {
        if (!resources) {
            return;
        }

        if (resources.length === 1) {
            // a resource group proxy object?
            const [resourceGroup] = resources;
            if (isResourceGroup(resourceGroup)) {
                // const groupId = resourceGroup.id;
                const resources =
                    resourceGroup.resourceStates as FossilResource[];
                return this.openChange(...resources);
            }
        }

        const preview = resources.length === 1 ? undefined : false;
        for (const resource of resources) {
            await this._openResource(resource, preview, true, false);
        }
    }

    @command('fossil.openFileFromUri')
    async openFileFromUri(uri?: Uri): Promise<void> {
        const resource = this.getSCMResource(uri);

        if (!resource) {
            return;
        }

        return await this.openFile(resource);
    }

    @command('fossil.openChangeFromUri')
    async openChangeFromUri(uri?: Uri): Promise<void> {
        const resource = this.getSCMResource(uri);

        if (!resource) {
            return;
        }

        return await this._openResource(resource);
    }

    @command('fossil.ignore')
    async ignore(
        ...resourceStates: SourceControlResourceState[]
    ): Promise<void> {
        if (resourceStates.length === 0) {
            const resource = this.getSCMResource();

            if (!resource) {
                return;
            }

            resourceStates = [resource];
        }

        const scmResources = resourceStates.filter(
            s => s instanceof FossilResource && s.resourceGroup.is('untracked')
        );

        if (!scmResources.length) {
            return;
        }

        const resources = scmResources.map(r => r.resourceUri);
        const repository = this.model.getRepository(resources[0]);
        if (repository) {
            await repository.ignore(...resources);
        }
        // await this.runByRepository(resources, async (repository, uris) => repository.ignore(...uris));
    }

    @command('fossil.addAll', { repository: true })
    async addAll(repository: Repository): Promise<void> {
        return await repository.add();
    }

    @command('fossil.add')
    async add(...resourceStates: SourceControlResourceState[]): Promise<void> {
        if (resourceStates.length === 0) {
            const resource = this.getSCMResource();

            if (!resource) {
                return;
            }

            resourceStates = [resource];
        }

        const scmResources = resourceStates.filter(
            s => s instanceof FossilResource && s.resourceGroup.is('untracked')
        );

        if (!scmResources.length) {
            return;
        }

        const resources = scmResources.map(r => r.resourceUri);
        const repository = this.model.getRepository(resources[0]);
        if (repository) {
            await repository.add(...resources);
        }
    }

    @command('fossil.remove')
    async remove(
        ...resourceStates: SourceControlResourceState[]
    ): Promise<void> {
        if (resourceStates.length === 0) {
            const resource = this.getSCMResource();

            if (!resource) {
                return;
            }

            resourceStates = [resource];
        }

        const scmResources = resourceStates.filter(
            s => s instanceof FossilResource && s.resourceGroup.is('working')
        );

        if (!scmResources.length) {
            return;
        }

        const resources = scmResources.map(r => r.resourceUri);
        const repository = this.model.getRepository(resources[0]);
        if (repository) {
            await repository.remove(...resources);
        }
        // await this.runByRepository(resources, async (repository, uris) => repository.remove(...uris));
    }

    private async deleteResources(
        repository: Repository,
        resources: SourceControlResourceState[]
    ): Promise<void> {
        const paths = resources
            .filter(resource => resource.resourceUri.scheme === 'file')
            .map(resource => resource.resourceUri.fsPath);
        if (await interaction.confirmDeleteResources(paths)) {
            await repository.clean(paths);
        }
    }

    @command('fossil.deleteFile', { repository: true })
    async deleteFile(
        repository: Repository,
        ...resourceStates: SourceControlResourceState[]
    ): Promise<void> {
        return this.deleteResources(repository, resourceStates);
    }

    @command('fossil.deleteFiles', { repository: true })
    async deleteFiles(
        repository: Repository,
        ...resourceGroups: FossilResourceGroup[]
    ): Promise<void> {
        return this.deleteResources(
            repository,
            resourceGroups.map(group => group.resourceStates).flat()
        );
    }

    @command('fossil.stage') // run by repo
    async stage(
        ...resourceStates: SourceControlResourceState[]
    ): Promise<void> {
        if (resourceStates.length === 0) {
            const resource = this.getSCMResource();

            if (!resource) {
                return;
            }

            resourceStates = [resource];
        }

        const scmResources = resourceStates.filter(
            s =>
                s instanceof FossilResource &&
                (s.resourceGroup.is('working') ||
                    s.resourceGroup.is('merge') ||
                    s.resourceGroup.is('untracked'))
        );

        if (!scmResources.length) {
            return;
        }

        const resources = scmResources.map(r => r.resourceUri);
        const repository = this.model.getRepository(resources[0]);
        if (repository) {
            await repository.stage(...resources);
        }
        // await this.runByRepository(resources, async (repository, uris) => repository.stage(...uris));
    }

    @command('fossil.stageAll', { repository: true })
    async stageAll(repository: Repository): Promise<void> {
        await repository.stage();
    }

    @command('fossil.unstage')
    async unstage(
        ...resourceStates: SourceControlResourceState[]
    ): Promise<void> {
        if (resourceStates.length === 0) {
            const resource = this.getSCMResource();

            if (!resource) {
                return;
            }

            resourceStates = [resource];
        }

        const scmResources = resourceStates.filter(
            s => s instanceof FossilResource && s.resourceGroup.is('staging')
        );

        if (!scmResources.length) {
            return;
        }

        const resources = scmResources.map(r => r.resourceUri);
        const repository = this.model.getRepository(resources[0]);
        if (repository) {
            await repository.unstage(...resources);
        }
        // await this.runByRepository(resources, async (repository, uris) => repository.unstage(...uris));
    }

    @command('fossil.unstageAll', { repository: true })
    async unstageAll(repository: Repository): Promise<void> {
        return await repository.unstage();
    }

    @command('fossil.revert')
    async revert(
        ...resourceStates: SourceControlResourceState[]
    ): Promise<void> {
        if (resourceStates.length === 0) {
            const resource = this.getSCMResource();

            if (!resource) {
                return;
            }

            resourceStates = [resource];
        }

        const scmResources = resourceStates.filter(
            (s): s is FossilResource =>
                s instanceof FossilResource && s.isDirtyStatus
        );

        if (!scmResources.length) {
            return;
        }

        const [discardResources, addedResources] = partition(
            scmResources,
            s => s.status !== Status.ADDED
        );
        if (discardResources.length > 0) {
            const confirmFilenames = discardResources.map(r =>
                path.basename(r.resourceUri.fsPath)
            );
            const addedFilenames = addedResources.map(r =>
                path.basename(r.resourceUri.fsPath)
            );

            const confirmed = await interaction.confirmDiscardChanges(
                confirmFilenames,
                addedFilenames
            );
            if (!confirmed) {
                return;
            }
        }

        const resources = scmResources.map(r => r.resourceUri);
        const repository = this.model.getRepository(resources[0]);
        if (repository) {
            await repository.revert(...resources);
        }
        // await this.runByRepository(resources, async (repository, uris) => repository.revert(...uris));
    }

    @command('fossil.revertAll', { repository: true })
    async revertAll(repository: Repository): Promise<void> {
        if (await interaction.confirmDiscardAllChanges()) {
            const resources = repository.workingGroup.resourceStates;
            await repository.revert(...resources.map(r => r.resourceUri));
        }
    }

    @command('fossil.clean', { repository: true })
    async clean(repository: Repository): Promise<void> {
        if (await interaction.confirmDeleteExtras()) {
            await repository.cleanAll();
        }
    }

    private async checkTrackedUnsavedFiles(
        repository: Repository
    ): Promise<boolean> {
        const allUnsavedDocuments = workspace.textDocuments.filter(
            doc => !doc.isUntitled && doc.isDirty
        );
        const existingUris = new Set<string>();
        if (allUnsavedDocuments) {
            (
                await repository.ls(...allUnsavedDocuments.map(doc => doc.uri))
            ).map(uri => existingUris.add(uri.fsPath));
        }
        const documents = allUnsavedDocuments.filter(
            doc =>
                existingUris.has(doc.uri.fsPath) ||
                repository.isInAnyGroup(doc.uri)
        );
        if (documents.length > 0) {
            const message =
                documents.length === 1
                    ? localize(
                          'unsaved files single',
                          "The following file has unsaved changes which won't be included in the commit if you proceed: {0}.\n\nWould you like to save it before committing?",
                          path.basename(documents[0].uri.fsPath)
                      )
                    : localize(
                          'unsaved files',
                          'There are {0} unsaved files.\n\nWould you like to save them before committing?',
                          documents.length
                      );
            const saveAndCommit = localize(
                'save and commit',
                'Save All & Commit'
            );
            const commit = localize('commit', 'Commit Staged Changes');
            const pick = await window.showWarningMessage(
                message,
                { modal: true },
                saveAndCommit,
                commit
            );

            if (pick === saveAndCommit) {
                await Promise.all(documents.map(d => d.save()));
                await repository.add(...documents.map(d => d.uri));
            } else if (pick !== commit) {
                return false; // do not commit on cancel
            }
        }
        return true;
    }
    private async validateNoConflicts(
        repository: Repository,
        opts: CommitOptions
    ): Promise<boolean> {
        const numConflictResources =
            repository.conflictGroup.resourceStates.length;
        if (numConflictResources > 0) {
            interaction.warnResolveConflicts();
            return false;
        }
        const numWorkingResources =
            repository.workingGroup.resourceStates.length;
        const numStagingResources =
            repository.stagingGroup.resourceStates.length;
        const isMergeCommit = repository.repoStatus?.isMerge;

        if (isMergeCommit) {
            opts.scope = CommitScope.ALL;
        } else {
            if (opts.scope === CommitScope.UNKNOWN) {
                if (numWorkingResources > 0 && numStagingResources == 0) {
                    const useWorkingGroup =
                        await interaction.confirmCommitWorkingGroup();
                    if (!useWorkingGroup) {
                        return false;
                    }
                    opts.scope = CommitScope.WORKING_GROUP;
                } else {
                    opts.scope = CommitScope.STAGING_GROUP;
                }
            }

            if (opts.scope === CommitScope.WORKING_GROUP) {
                const missingResources =
                    repository.workingGroup.resourceStates.filter(
                        r => r.status === Status.MISSING
                    );
                if (missingResources.length > 0) {
                    const missingFilenames = missingResources.map(r =>
                        repository.mapResourceToWorkspaceRelativePath(r)
                    );
                    const deleteConfirmed =
                        await interaction.confirmDeleteMissingFilesForCommit(
                            missingFilenames
                        );
                    if (!deleteConfirmed) {
                        return false;
                    }
                    await this.remove(...missingResources);
                }
            }

            if (
                (numWorkingResources === 0 && numStagingResources === 0) || // no changes
                (opts &&
                    opts.scope === CommitScope.STAGING_GROUP &&
                    numStagingResources === 0) || // no staged changes
                (opts &&
                    opts.scope === CommitScope.WORKING_GROUP &&
                    numWorkingResources === 0) // no working directory changes
            ) {
                interaction.informNoChangesToCommit();
                return false;
            }
        }
        return true;
    }

    private async smartCommit(
        repository: Repository,
        getCommitMessage: () => Promise<string | undefined>,
        opts: CommitOptions = { scope: CommitScope.UNKNOWN }
    ): Promise<boolean> {
        if (
            !this.checkTrackedUnsavedFiles(repository) ||
            !this.validateNoConflicts(repository, opts)
        ) {
            return false;
        }
        const branch: FossilBranch | undefined =
            (opts.useBranch || undefined) &&
            (await interaction.inputNewBranchName());

        const message = await getCommitMessage();

        if (message === undefined) {
            return false;
        }

        await repository.commit(message, opts.scope, branch);

        return true;
    }

    private async commitWithAnyInput(
        repository: Repository,
        opts: CommitOptions = { scope: CommitScope.UNKNOWN }
    ): Promise<void> {
        const inputBox = repository.sourceControl.inputBox;
        const message = inputBox.value;
        const didCommit = await this.smartCommit(
            repository,
            () => interaction.inputCommitMessage(message),
            opts
        );

        if (message && didCommit) {
            inputBox.value = '';
        }
    }

    @command('fossil.commit', { repository: true })
    async commit(repository: Repository): Promise<void> {
        await this.commitWithAnyInput(repository);
    }

    @command('fossil.commitWithInput', { repository: true })
    async commitWithInput(repository: Repository): Promise<void> {
        const didCommit = await this.smartCommit(
            repository,
            async () => repository.sourceControl.inputBox.value
        );

        if (didCommit) {
            repository.sourceControl.inputBox.value = '';
        }
    }

    @command('fossil.commitStaged', { repository: true })
    async commitStaged(repository: Repository): Promise<void> {
        await this.commitWithAnyInput(repository, {
            scope: CommitScope.STAGING_GROUP,
        });
    }

    @command('fossil.commitAll', { repository: true })
    async commitAll(repository: Repository): Promise<void> {
        await this.commitWithAnyInput(repository, { scope: CommitScope.ALL });
    }

    @command('fossil.commitBranch', { repository: true })
    async commitBranch(repository: Repository): Promise<void> {
        await this.commitWithAnyInput(repository, {
            scope: CommitScope.UNKNOWN,
            useBranch: true,
        });
    }

    private focusScm() {
        commands.executeCommand('workbench.view.scm');
    }

    private async undoOrRedo(repository: Repository, command: 'undo' | 'redo') {
        try {
            const undo = await repository.undoOrRedo(command, true); // dry-run
            if (await interaction.confirmUndoOrRedo(command, undo)) {
                await repository.undoOrRedo(command, false); // real-thing
            }
        } catch (e) {
            if (
                e instanceof FossilError &&
                e.fossilErrorCode === 'NoUndoInformationAvailable'
            ) {
                await interaction.warnNoUndoOrRedo(command);
            }
        }
    }

    @command('fossil.undo', { repository: true })
    async undo(repository: Repository): Promise<void> {
        return this.undoOrRedo(repository, 'undo');
    }

    @command('fossil.redo', { repository: true })
    async redo(repository: Repository): Promise<void> {
        return this.undoOrRedo(repository, 'redo');
    }

    @command('fossil.patchCreate', { repository: true })
    async patchCreate(repository: Repository): Promise<void> {
        const newPatchPath = await interaction.inputPatchCreate();
        if (newPatchPath) {
            await repository.patchCreate(newPatchPath);
        }
    }

    @command('fossil.patchApply', { repository: true })
    async patchApply(repository: Repository): Promise<void> {
        const newPatchPath = await interaction.inputPatchApply();
        if (newPatchPath) {
            await repository.patchApply(newPatchPath);
        }
    }

    @command('fossil.update', { repository: true })
    async update(repository: Repository): Promise<void> {
        const unclean = false;

        // branches/tags
        if (
            (await interaction.checkThenWarnOutstandingMerge(repository)) ||
            (await interaction.checkThenErrorUnclean(
                repository,
                WarnScenario.Update
            ))
        ) {
            this.focusScm();
            return;
        }
        const refs = await repository.getBranchesAndTags();

        const choice = await interaction.pickUpdateRevision(refs, unclean);

        if (choice) {
            await choice.run(repository);
        }
    }

    @command('fossil.branchChange', { repository: true })
    async branchChange(repository: Repository): Promise<void> {
        const unclean = false;

        // branches/tags
        if (await interaction.checkThenWarnOutstandingMerge(repository)) {
            this.focusScm();
            return;
        }
        await interaction.checkThenWarnUnclean(repository, WarnScenario.Update);
        const refs = await repository.getBranchesAndTags();

        const choice = await interaction.pickUpdateRevision(refs, unclean);

        if (choice) {
            await choice.run(repository);
        }
    }

    @command('fossil.branch', { repository: true })
    async branch(repository: Repository): Promise<void> {
        const fossilBranch = await interaction.inputNewBranchName();
        if (!fossilBranch) {
            return;
        }
        try {
            await repository.newBranch(fossilBranch);
        } catch (e) {
            if (
                e instanceof FossilError &&
                e.fossilErrorCode === 'BranchAlreadyExists'
            ) {
                const action = await interaction.warnBranchAlreadyExists(
                    fossilBranch
                );
                if (action === BranchExistsAction.Reopen) {
                    await repository.newBranch(fossilBranch);
                } else if (action === BranchExistsAction.UpdateTo) {
                    await repository.update(fossilBranch);
                }
            }
        }
    }

    @command('fossil.pull', { repository: true })
    async pull(repository: Repository): Promise<void> {
        const paths = await repository.getPath();

        if (paths.url == '') {
            return interaction.warnNoPaths('pull');
        }

        const pullOptions = await repository.createPullOptions();
        await repository.pull(pullOptions);
    }

    private async isItOkayToMerge(repository: Repository): Promise<boolean> {
        if (
            (await interaction.checkThenWarnOutstandingMerge(repository)) ||
            (await interaction.checkThenErrorUnclean(
                repository,
                WarnScenario.Merge
            ))
        ) {
            this.focusScm();
            return false;
        }
        return true;
    }

    private async mergeCommon(
        repository: Repository,
        mergeAction: MergeAction,
        placeholder: string
    ): Promise<void> {
        if (!(await this.isItOkayToMerge(repository))) {
            return;
        }

        const openedBranches = await repository.getBranches();
        const branch = await interaction.pickBranch(
            openedBranches,
            placeholder
        );
        if (branch) {
            return this.doMerge(repository, branch, mergeAction);
        }
    }

    @command('fossil.merge', { repository: true })
    async merge(repository: Repository): Promise<void> {
        const placeholder = localize(
            'choose branch',
            'Choose branch to merge into working directory:'
        );
        return this.mergeCommon(repository, MergeAction.Merge, placeholder);
    }

    @command('fossil.integrate', { repository: true })
    async integrate(repository: Repository): Promise<void> {
        const placeholder = localize(
            'choose branch integrate',
            'Choose branch to integrate into working directory:'
        );
        return this.mergeCommon(repository, MergeAction.Integrate, placeholder);
    }

    @command('fossil.cherrypick', { repository: true })
    async cherrypick(repository: Repository): Promise<void> {
        if (!(await this.isItOkayToMerge(repository))) {
            return;
        }
        const logEntries = await repository.getLogEntries();
        const checkin = await interaction.pickCommitToCherrypick(logEntries);

        if (checkin) {
            return this.doMerge(repository, checkin, MergeAction.Cherrypick);
        }
    }

    private async doMerge(
        repository: Repository,
        otherRevision: FossilCheckin,
        mergeAction: MergeAction
    ) {
        try {
            const result = await repository.merge(otherRevision, mergeAction);
            const { currentBranch } = repository;

            if (result.unresolvedCount > 0) {
                interaction.warnUnresolvedFiles(result.unresolvedCount);
            } else if (currentBranch) {
                const defaultMergeMessage = humanise.describeMerge(
                    currentBranch,
                    otherRevision
                );
                const didCommit = await this.smartCommit(
                    repository,
                    async () =>
                        await interaction.inputCommitMessage(
                            '',
                            defaultMergeMessage
                        )
                );

                if (didCommit) {
                    repository.sourceControl.inputBox.value = '';
                }
            }
        } catch (e) {
            if (
                e instanceof FossilError &&
                e.fossilErrorCode === 'UntrackedFilesDiffer' &&
                e.untrackedFilenames
            ) {
                interaction.errorUntrackedFilesDiffer(e.untrackedFilenames);
                return;
            }

            throw e;
        }
    }

    @command('fossil.closeBranch', { repository: true })
    async closeBranch(repository: Repository): Promise<void> {
        const openedBranches = await repository.getBranches();
        const placeholder = localize('branchtoclose', 'Branch to close');
        const branch = await interaction.pickBranch(
            openedBranches,
            placeholder
        );
        if (branch) {
            return repository.addTag(branch, 'closed');
        }
    }

    @command('fossil.reopenBranch', { repository: true })
    async reopenBranch(repository: Repository): Promise<void> {
        const openedBranches = await repository.getBranches({ closed: true });
        const placeholder = localize('branchtoreopen', 'Branch to reopen');
        const branch = await interaction.pickBranch(
            openedBranches,
            placeholder
        );
        if (branch) {
            return repository.cancelTag(branch, 'closed');
        }
    }

    @command('fossil.push', { repository: true })
    async push(repository: Repository): Promise<void> {
        await repository.push(undefined);
    }

    @command('fossil.pushTo', { repository: true })
    async pushTo(repository: Repository): Promise<void> {
        const path = await repository.getPath();

        if (path.url == '') {
            return interaction.warnNoPaths('push');
        }
        repository.push(path.url);
    }

    @command('fossil.showOutput')
    showOutput(): void {
        this.outputChannel.show();
    }

    @command('fossil.openui', { repository: true })
    async openUi(repository: Repository): Promise<void> {
        const terminal = window.createTerminal({
            name: 'Fossil UI',
            cwd: repository.root,
        });
        terminal.sendText('fossil ui', true);
        //  await commands.executeCommand<void>(
        //     'simpleBrowser.show',
        //     'http://127.0.0.1:8000'
        //     );
    }

    createLogMenuAPI(repository: Repository): LogMenuAPI {
        return {
            getBranchName: () => repository.currentBranch,
            getCommitDetails: (checkin: FossilCheckin) =>
                repository.getCommitDetails(checkin),
            getLogEntries: (options: LogEntriesOptions) =>
                repository.getLogEntries(options),
            // diffToLocal: (_file: IFileStatus, _commit: CommitDetails) => { },
            diffToParent: (file: IFileStatus, commit: CommitDetails) =>
                this.diffFile(repository, commit.hash, file),
        };
    }

    @command('fossil.log', { repository: true })
    async log(repository: Repository): Promise<void> {
        await interaction.presentLogSourcesMenu(
            this.createLogMenuAPI(repository)
        );
    }

    @command('fossil.fileLog')
    async fileLog(uri?: Uri): Promise<void> {
        if (!uri) {
            uri = window.activeTextEditor?.document.uri;
        }
        if (!uri || uri.scheme !== 'file') {
            return;
        }

        const repository = this.model.getRepository(uri);
        if (!repository) {
            return;
        }

        const onCommitPicked = (checkin: FossilCheckin) => async () => {
            await interaction.pickDiffAction(
                logEntries,
                (to: FossilHash | FossilSpecialTags | undefined) =>
                    (): Promise<void> =>
                        this.diff(repository, checkin, to, uri!),
                this.fileLog
            );
        };

        const logEntries = await repository.getLogEntries({ fileUri: uri });
        const choice = await interaction.pickCommit(
            CommitSources.File,
            logEntries,
            onCommitPicked
        );

        if (choice) {
            await choice.run();
        }
    }

    @command('fossil.revertChange')
    async revertChange(
        uri: Uri,
        changes: LineChange[],
        index: number
    ): Promise<void> {
        if (!uri) {
            return;
        }
        const textEditor = window.visibleTextEditors.filter(
            e => e.document.uri.toString() === uri.toString()
        )[0];
        if (!textEditor) {
            return;
        }
        await revertChanges(textEditor, [
            ...changes.slice(0, index),
            ...changes.slice(index + 1),
        ]);
        const firstStagedLine = changes[index].modifiedStartLineNumber - 1;
        textEditor.selections = [
            new Selection(firstStagedLine, 0, firstStagedLine, 0),
        ];
    }

    /** When user selects one of the modified files using 'fossil.log' command */
    private async diffFile(
        repository: Repository,
        checkin: FossilCheckin,
        file: IFileStatus
    ): Promise<void> {
        const uri = repository.toUri(file.path);
        const parent: FossilCheckin = await repository.getInfo(
            checkin,
            'parent'
        );
        const left = toFossilUri(uri, parent);
        const right = toFossilUri(uri, checkin);
        const baseName = path.basename(uri.fsPath);
        const title = `${baseName} (${parent.slice(0, 12)} vs. ${checkin.slice(
            0,
            12
        )})`;

        if (left && right) {
            return await commands.executeCommand<void>(
                'vscode.diff',
                left,
                right,
                title
            );
        }
    }

    private async diff(
        repository: Repository,
        source: FossilCheckin,
        target: FossilHash | FossilSpecialTags | undefined,
        uri: Uri
    ) {
        const fromUri = toFossilUri(uri, source);
        switch (target) {
            case 'parent':
                target = await repository.getInfo(source, 'parent');
                break;
        }
        const toUri = toFossilUri(uri, target);
        const fromName = source.slice(0, 12);
        const toName = (target || 'local').slice(0, 12);
        const relativePath = repository.mapFileUriToWorkspaceRelativePath(uri);
        const title = `${relativePath} (${fromName} vs. ${toName})`;

        return await commands.executeCommand<void>(
            'vscode.diff',
            fromUri,
            toUri,
            title
        );
    }

    private createCommand(
        id: string,
        key: string,
        method: Function,
        options: CommandOptions
    ): (...args: any[]) => Promise<any> | undefined {
        const res = async (...args: SourceControl[]) => {
            let result: Promise<any>;
            if (!options.repository) {
                result = Promise.resolve(method.apply(this, args));
            } else {
                // try to guess the repository based on the first argument
                const repository = this.model.getRepository(args[0]);
                let repositoryPromise: Promise<Repository | undefined>;

                if (repository) {
                    repositoryPromise = Promise.resolve(repository);
                } else if (this.model.repositories.length === 1) {
                    repositoryPromise = Promise.resolve(
                        this.model.repositories[0]
                    );
                } else {
                    repositoryPromise = this.model.pickRepository();
                }

                result = repositoryPromise.then(repository => {
                    if (!repository) {
                        return Promise.resolve();
                    }

                    return Promise.resolve(
                        method.apply(this, [repository, ...args])
                    );
                });
            }

            try {
                return result; // ??? this line will never throw?
            } catch (err) {
                const openLog = await interaction.errorPromptOpenLog(err);
                if (openLog) {
                    this.outputChannel.show();
                } else {
                    this.focusScm();
                }
            }
        };

        // patch this object, so people can call methods directly
        this[key] = res;
        return res;
    }

    private getSCMResource(uri?: Uri): FossilResource | undefined {
        uri = uri
            ? uri
            : window.activeTextEditor && window.activeTextEditor.document.uri;

        if (!uri) {
            return undefined;
        }

        if (uri.scheme === 'fossil') {
            uri = uri.with({ scheme: 'file' });
        }

        if (uri.scheme === 'file') {
            const repository = this.model.getRepository(uri);

            if (!repository) {
                return undefined;
            }

            return (
                repository.workingGroup.getResource(uri) ||
                repository.stagingGroup.getResource(uri) ||
                repository.untrackedGroup.getResource(uri) ||
                repository.mergeGroup.getResource(uri) ||
                repository.conflictGroup.getResource(uri)
            );
        }
        return undefined;
    }

    // private runByRepository<T>(resource: Uri, fn: (repository: Repository, resource: Uri) => Promise<T>): Promise<T[]>;
    // private runByRepository<T>(resources: Uri[], fn: (repository: Repository, resources: Uri[]) => Promise<T>): Promise<T[]>;
    // private async runByRepository<T>(arg: Uri | Uri[], fn: (repository: Repository, resources: any) => Promise<T>): Promise<T[]> {
    //     const resources = arg instanceof Uri ? [arg] : arg;
    //     const isSingleResource = arg instanceof Uri;

    //     const groups = resources.reduce((result, resource) => {
    //         const repository = this.model.getRepository(resource);

    //         if (!repository) {
    //             console.warn('Could not find fossil repository for ', resource);
    //             return result;
    //         }

    //         const tuple = result.filter(p => p[0] === repository)[0];

    //         if (tuple) {
    //             tuple.resources.push(resource);
    //         } else {
    //             result.push({ repository, resources: [resource] });
    //         }

    //         return result;
    //     }, [] as { repository: Repository, resources: Uri[] }[]);

    //     const promises = groups
    //         .map(({ repository, resources }) => fn(repository as Repository, isSingleResource ? resources[0] : resources));

    //     return Promise.all(promises);
    // }

    dispose(): void {
        this.disposables.forEach(d => d.dispose());
    }
}
