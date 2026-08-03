/*
 * Notebook Navigator - Plugin for Obsidian
 * Copyright (c) 2025-2026 Johan Sanneblad
 *
 * Local patch: host the horizontal desktop list pane in a main-workspace leaf.
 */

import { EventRef, WorkspaceLeaf, WorkspaceTabs } from 'obsidian';
import type NotebookNavigatorPlugin from '../../main';
import { NOTEBOOK_NAVIGATOR_DETACHED_LIST_VIEW } from '../../types';
import { getLeafSplitLocation } from '../../utils/workspaceSplit';

type HostListener = (host: HTMLElement | null) => void;
type WorkspaceTabsWithChildren = WorkspaceTabs & { children: WorkspaceLeaf[] };

const DEFAULT_LIST_WIDTH = 420;
const MIN_LIST_WIDTH = 250;
const MIN_EDITOR_WIDTH = 320;

export class DetachedListPaneService {
    private readonly plugin: NotebookNavigatorPlugin;
    private host: HTMLElement | null = null;
    private tabsContainer: HTMLElement | null = null;
    private listeners = new Set<HostListener>();
    private layoutEventRef: EventRef | null = null;
    private workspaceObserver: MutationObserver | null = null;
    private requestedActive = false;
    private navigationWidth = 300;
    private originalCombinedWidth: number | null = null;
    private createdLeafThisSession = false;
    private detachedLeaf: WorkspaceLeaf | null = null;
    private ensurePromise: Promise<void> | null = null;
    private geometryTimer: number | null = null;
    private geometryAttempts = 0;
    private disposed = false;
    private preferredListWidth: number | null = null;
    private hostWindow: Window | null = null;
    private listResizeArmed = false;
    private readonly handlePointerDown = (event: PointerEvent): void => {
        this.listResizeArmed = this.isDetachedListResizeHandle(event.target);
    };
    private readonly handlePointerUp = (): void => {
        const shouldCapture = this.listResizeArmed;
        this.listResizeArmed = false;
        if (shouldCapture) {
            this.captureCurrentListWidth();
        }
    };
    private readonly handlePointerCancel = (): void => {
        this.listResizeArmed = false;
    };
    private expandedGeometry: {
        width: string;
        minWidth: string;
        flexGrow: string;
        flexShrink: string;
        flexBasis: string;
    } | null = null;

    constructor(plugin: NotebookNavigatorPlugin) {
        this.plugin = plugin;
    }

    start(): void {
        if (this.layoutEventRef) {
            return;
        }
        this.layoutEventRef = this.plugin.app.workspace.on('layout-change', () => {
            this.syncVisibility();
            void this.ensureLeaf().then(() => this.syncVisibility());
        });
        const workspaceEl = activeDocument.querySelector<HTMLElement>('.workspace');
        if (workspaceEl) {
            this.workspaceObserver = new MutationObserver(() => this.syncVisibility());
            this.workspaceObserver.observe(workspaceEl, { attributes: true, attributeFilter: ['class'] });
        }
    }

    dispose(): void {
        this.disposed = true;
        if (this.layoutEventRef) {
            this.plugin.app.workspace.offref(this.layoutEventRef);
            this.layoutEventRef = null;
        }
        this.workspaceObserver?.disconnect();
        this.workspaceObserver = null;
        this.hostWindow?.removeEventListener('pointerdown', this.handlePointerDown, true);
        this.hostWindow?.removeEventListener('pointerup', this.handlePointerUp, true);
        this.hostWindow?.removeEventListener('pointercancel', this.handlePointerCancel, true);
        this.hostWindow = null;
        this.listResizeArmed = false;
        this.listeners.clear();
        if (this.geometryTimer !== null) {
            window.clearTimeout(this.geometryTimer);
            this.geometryTimer = null;
        }
        this.host = null;
        if (this.tabsContainer) {
            this.resetTabsContainer(this.tabsContainer);
        }
        this.tabsContainer = null;
        this.expandedGeometry = null;
        const leafToDetach = this.detachedLeaf;
        this.detachedLeaf = null;
        if (leafToDetach) {
            window.setTimeout(() => leafToDetach.detach(), 0);
        }
    }

    getHost(): HTMLElement | null {
        return this.host;
    }

    subscribe(listener: HostListener): () => void {
        this.listeners.add(listener);
        listener(this.host);
        return () => this.listeners.delete(listener);
    }

    attachHost(host: HTMLElement, tabsContainer: HTMLElement | null): void {
        if (this.tabsContainer && this.tabsContainer !== tabsContainer) {
            this.resetTabsContainer(this.tabsContainer);
        }
        this.host = host;
        this.tabsContainer = tabsContainer;
        tabsContainer?.classList.add('nn-detached-list-workspace-tabs');
        this.hostWindow?.removeEventListener('pointerdown', this.handlePointerDown, true);
        this.hostWindow?.removeEventListener('pointerup', this.handlePointerUp, true);
        this.hostWindow?.removeEventListener('pointercancel', this.handlePointerCancel, true);
        this.hostWindow = host.ownerDocument.defaultView;
        this.hostWindow?.addEventListener('pointerdown', this.handlePointerDown, true);
        this.hostWindow?.addEventListener('pointerup', this.handlePointerUp, true);
        this.hostWindow?.addEventListener('pointercancel', this.handlePointerCancel, true);
        this.notifyHostListeners();
        this.configureGeometry();
        this.syncVisibility();
    }

    detachHost(host: HTMLElement): void {
        if (this.host !== host) {
            return;
        }
        if (this.geometryTimer !== null) {
            window.clearTimeout(this.geometryTimer);
            this.geometryTimer = null;
        }
        if (this.tabsContainer) {
            this.resetTabsContainer(this.tabsContainer);
        }
        this.hostWindow?.removeEventListener('pointerdown', this.handlePointerDown, true);
        this.hostWindow?.removeEventListener('pointerup', this.handlePointerUp, true);
        this.hostWindow?.removeEventListener('pointercancel', this.handlePointerCancel, true);
        this.hostWindow = null;
        this.listResizeArmed = false;
        this.host = null;
        this.tabsContainer = null;
        this.expandedGeometry = null;
        this.notifyHostListeners();
    }

    async setActive(active: boolean, navigationWidth: number): Promise<void> {
        this.requestedActive = active;
        if (Number.isFinite(navigationWidth) && navigationWidth > 0) {
            this.navigationWidth = navigationWidth;
        }

        if (!active) {
            this.syncVisibility();
            return;
        }

        this.captureCombinedWidth();
        await this.ensureLeaf();
        this.syncVisibility();
        this.configureGeometry();
    }

    private notifyHostListeners(): void {
        for (const listener of this.listeners) {
            listener(this.host);
        }
    }

    private getLeftSplitElement(doc: Document = activeDocument): HTMLElement | null {
        return doc.querySelector<HTMLElement>('.workspace-split.mod-left-split');
    }

    private captureCombinedWidth(): void {
        if (this.originalCombinedWidth !== null) {
            return;
        }
        const leftSplitEl = this.getLeftSplitElement();
        const width = leftSplitEl?.getBoundingClientRect().width ?? 0;
        if (width > this.navigationWidth) {
            this.originalCombinedWidth = width;
        }
    }

    private findMainTargetLeaf(): WorkspaceLeaf | null {
        const { workspace } = this.plugin.app;
        const recent = workspace.getMostRecentLeaf(workspace.rootSplit);
        if (recent && recent.getViewState().type !== NOTEBOOK_NAVIGATOR_DETACHED_LIST_VIEW) {
            return recent;
        }

        let target: WorkspaceLeaf | null = null;
        workspace.iterateAllLeaves(leaf => {
            if (
                !target &&
                getLeafSplitLocation(this.plugin.app, leaf) === 'main' &&
                leaf.getViewState().type !== NOTEBOOK_NAVIGATOR_DETACHED_LIST_VIEW
            ) {
                target = leaf;
            }
        });
        return target;
    }

    private async ensureLeaf(): Promise<void> {
        if (this.disposed) {
            return;
        }
        const hasDetachedLeaf =
            this.plugin.app.workspace.getLeavesOfType(NOTEBOOK_NAVIGATOR_DETACHED_LIST_VIEW).length > 0;
        if (!this.requestedActive && !hasDetachedLeaf) {
            return;
        }
        if (this.ensurePromise) {
            await this.ensurePromise;
            return;
        }

        this.ensurePromise = this.ensureLeafInternal();
        try {
            await this.ensurePromise;
        } finally {
            this.ensurePromise = null;
        }
    }

    private async ensureLeafInternal(): Promise<void> {
        const { workspace } = this.plugin.app;
        const detachedLeaves = workspace.getLeavesOfType(NOTEBOOK_NAVIGATOR_DETACHED_LIST_VIEW);
        const existing =
            (this.detachedLeaf && detachedLeaves.includes(this.detachedLeaf) ? this.detachedLeaf : detachedLeaves[0]) ?? null;
        if (existing) {
            this.detachedLeaf = existing;
            await existing.loadIfDeferred();
            existing.setPinned(true);
            await this.ensureDetachedLeafIsolation(existing);
            return;
        }

        if (!this.requestedActive) {
            return;
        }

        const target = this.findMainTargetLeaf();
        if (!target) {
            return;
        }

        const previouslyActive = workspace.getMostRecentLeaf(workspace.rootSplit);
        const leaf = workspace.createLeafBySplit(target, 'vertical', true);
        this.detachedLeaf = leaf;
        this.createdLeafThisSession = true;
        await leaf.setViewState({
            type: NOTEBOOK_NAVIGATOR_DETACHED_LIST_VIEW,
            active: false
        });
        leaf.setPinned(true);

        if (previouslyActive && previouslyActive !== leaf) {
            workspace.setActiveLeaf(previouslyActive, { focus: false });
        }
        workspace.requestSaveLayout();
    }

    private getTabGroupLeaves(leaf: WorkspaceLeaf): WorkspaceLeaf[] {
        const parent = leaf.parent;
        if (!(parent instanceof WorkspaceTabs)) {
            return [];
        }
        return (parent as WorkspaceTabsWithChildren).children;
    }

    private async ensureDetachedLeafIsolation(leaf: WorkspaceLeaf): Promise<void> {
        const groupLeaves = this.getTabGroupLeaves(leaf);
        const mixedLeaf = groupLeaves.find(candidate => candidate !== leaf);
        if (mixedLeaf) {
            const target =
                mixedLeaf.getViewState().type === NOTEBOOK_NAVIGATOR_DETACHED_LIST_VIEW
                    ? this.findMainTargetLeaf()
                    : mixedLeaf;
            if (target && target !== leaf) {
                await this.replaceMixedDetachedLeaf(leaf, target);
            }
            return;
        }

        if (!this.findMainTargetLeaf()) {
            this.createMainCompanionLeaf(leaf);
        }
    }

    private async replaceMixedDetachedLeaf(oldLeaf: WorkspaceLeaf, target: WorkspaceLeaf): Promise<void> {
        const { workspace } = this.plugin.app;
        const oldTabsContainer = oldLeaf.view.containerEl.closest<HTMLElement>('.workspace-tabs');
        const previouslyActive = workspace.getMostRecentLeaf(workspace.rootSplit);
        const replacement = workspace.createLeafBySplit(target, 'vertical', true);
        this.detachedLeaf = replacement;
        this.createdLeafThisSession = false;

        await replacement.setViewState({
            type: NOTEBOOK_NAVIGATOR_DETACHED_LIST_VIEW,
            active: false
        });
        replacement.setPinned(true);
        await replacement.loadIfDeferred();

        if (oldTabsContainer) {
            this.resetTabsContainer(oldTabsContainer);
        }
        oldLeaf.detach();

        const leafToRestore =
            previouslyActive && previouslyActive !== oldLeaf && previouslyActive !== replacement
                ? previouslyActive
                : target;
        workspace.setActiveLeaf(leafToRestore, { focus: false });
        workspace.requestSaveLayout();
    }

    private createMainCompanionLeaf(detachedLeaf: WorkspaceLeaf): void {
        const { workspace } = this.plugin.app;
        const previouslyActive = workspace.getMostRecentLeaf(workspace.rootSplit);
        const mainLeaf = workspace.createLeafBySplit(detachedLeaf, 'vertical', false);
        if (previouslyActive && previouslyActive !== detachedLeaf) {
            workspace.setActiveLeaf(previouslyActive, { focus: false });
        } else {
            workspace.setActiveLeaf(mainLeaf, { focus: false });
        }
        workspace.requestSaveLayout();
    }

    private configureGeometry(): void {
        if (!this.requestedActive || !this.host || !this.tabsContainer) {
            return;
        }

        const doc = this.host.ownerDocument;
        const leftSplitEl = this.getLeftSplitElement(doc);
        if (leftSplitEl) {
            this.setElementCssProps(leftSplitEl, { width: `${Math.round(this.navigationWidth)}px` });
        }

        if (this.preferredListWidth === null) {
            const inlineWidth = Number.parseFloat(this.tabsContainer.style.width);
            const actualWidth = this.tabsContainer.getBoundingClientRect().width;
            const capturedListWidth = this.createdLeafThisSession
                ? this.originalCombinedWidth === null
                    ? DEFAULT_LIST_WIDTH
                    : Math.max(MIN_LIST_WIDTH, this.originalCombinedWidth - this.navigationWidth)
                : inlineWidth >= MIN_LIST_WIDTH
                  ? inlineWidth
                  : actualWidth >= MIN_LIST_WIDTH
                    ? actualWidth
                    : DEFAULT_LIST_WIDTH;
            this.preferredListWidth = Math.round(capturedListWidth);
        }

        const targetWidth = this.setFixedListWidth(this.preferredListWidth);
        if (this.createdLeafThisSession) {
            this.scheduleGeometryVerification(targetWidth);
        }
    }

    private setFixedListWidth(requestedWidth: number): number {
        const tabsContainer = this.tabsContainer;
        const rootSplit = tabsContainer?.parentElement;
        if (!tabsContainer || !rootSplit) {
            return requestedWidth;
        }

        const availableWidth = rootSplit.getBoundingClientRect().width;
        const targetWidth = Math.min(requestedWidth, Math.max(MIN_LIST_WIDTH, availableWidth - MIN_EDITOR_WIDTH));
        this.setTabsCssProps({
            width: `${Math.round(targetWidth)}px`,
            'min-width': `${MIN_LIST_WIDTH}px`,
            'flex-grow': '0',
            'flex-shrink': '0',
            'flex-basis': `${Math.round(targetWidth)}px`
        });
        this.normalizeSingleMainSibling(rootSplit);
        return targetWidth;
    }

    private normalizeSingleMainSibling(rootSplit: HTMLElement): void {
        const workspaceChildren = Array.from(
            rootSplit.querySelectorAll<HTMLElement>(':scope > .workspace-tabs, :scope > .workspace-split')
        );
        const mainSiblings = workspaceChildren.filter(child => child !== this.tabsContainer);
        if (mainSiblings.length !== 1) {
            return;
        }

        // Obsidian's split-resize code writes fixed widths to both siblings. The detached
        // list is intentionally fixed, so the sole main-workspace sibling must remain
        // flexible and consume the rest of the root split.
        this.setElementCssProps(mainSiblings[0], {
            width: '',
            'flex-grow': '1',
            'flex-shrink': '0',
            'flex-basis': '0px'
        });
    }

    private isDetachedListResizeHandle(target: EventTarget | null): boolean {
        const targetElement = target as Element | null;
        if (!targetElement || typeof targetElement.closest !== 'function') {
            return false;
        }

        const handle = targetElement.closest<HTMLElement>('.workspace-leaf-resize-handle');
        const tabsContainer = this.tabsContainer;
        if (!handle || !tabsContainer) {
            return false;
        }
        if (handle.parentElement === tabsContainer) {
            return true;
        }
        if (handle.parentElement !== tabsContainer.parentElement) {
            return false;
        }
        if (handle.previousElementSibling === tabsContainer || handle.nextElementSibling === tabsContainer) {
            return true;
        }

        const handleRect = handle.getBoundingClientRect();
        const tabsRect = tabsContainer.getBoundingClientRect();
        const handleCenterX = handleRect.left + handleRect.width / 2;
        return Math.min(Math.abs(handleCenterX - tabsRect.left), Math.abs(handleCenterX - tabsRect.right)) <= 12;
    }

    private captureCurrentListWidth(): void {
        const tabsContainer = this.tabsContainer;
        if (
            !this.requestedActive ||
            !tabsContainer ||
            tabsContainer.classList.contains('nn-detached-list-pane-inactive') ||
            tabsContainer.classList.contains('nn-detached-list-pane-collapsed')
        ) {
            return;
        }

        const width = Math.round(tabsContainer.getBoundingClientRect().width);
        if (width < MIN_LIST_WIDTH) {
            return;
        }
        this.preferredListWidth = width;
        this.setFixedListWidth(width);
        this.plugin.app.workspace.requestSaveLayout();
    }

    private scheduleGeometryVerification(targetWidth: number): void {
        if (this.geometryTimer !== null) {
            return;
        }
        this.geometryTimer = window.setTimeout(() => {
            this.geometryTimer = null;
            if (!this.createdLeafThisSession || !this.tabsContainer || !this.requestedActive) {
                return;
            }

            this.geometryAttempts += 1;
            const actualWidth = this.tabsContainer.getBoundingClientRect().width;
            if (Math.abs(actualWidth - targetWidth) <= 8 || this.geometryAttempts >= 10) {
                this.createdLeafThisSession = false;
                this.geometryAttempts = 0;
                return;
            }
            this.configureGeometry();
        }, 50);
    }

    private setTabsCssProps(properties: Record<string, string>): void {
        if (this.tabsContainer) {
            this.setElementCssProps(this.tabsContainer, properties);
        }
    }

    private setElementCssProps(element: HTMLElement, properties: Record<string, string>): void {
        for (const [property, value] of Object.entries(properties)) {
            if (element.style.getPropertyValue(property) === value) {
                continue;
            }
            if (value === '') {
                element.style.removeProperty(property);
            } else {
                element.style.setProperty(property, value);
            }
        }
    }

    private resetTabsContainer(tabsContainer: HTMLElement): void {
        tabsContainer.classList.remove(
            'nn-detached-list-workspace-tabs',
            'nn-detached-list-pane-collapsed',
            'nn-detached-list-pane-inactive'
        );
        this.setElementCssProps(tabsContainer, {
            width: '',
            'min-width': '',
            'flex-grow': '',
            'flex-shrink': '',
            'flex-basis': ''
        });
    }

    private syncVisibility(): void {
        const tabsContainer = this.tabsContainer;
        if (!tabsContainer) {
            return;
        }

        const leftCollapsed = this.plugin.app.workspace.leftSplit.collapsed;
        const inactive = !this.requestedActive;
        const collapsed = this.requestedActive && leftCollapsed;
        const shouldHide = inactive || collapsed;
        const wasHidden =
            tabsContainer.classList.contains('nn-detached-list-pane-inactive') ||
            tabsContainer.classList.contains('nn-detached-list-pane-collapsed');

        if (shouldHide) {
            if (!wasHidden) {
                this.expandedGeometry = {
                    width: tabsContainer.style.width,
                    minWidth: tabsContainer.style.minWidth,
                    flexGrow: tabsContainer.style.flexGrow,
                    flexShrink: tabsContainer.style.flexShrink,
                    flexBasis: tabsContainer.style.flexBasis
                };
            }
            this.setTabsCssProps({
                width: '0px',
                'min-width': '0px',
                'flex-grow': '0',
                'flex-shrink': '0',
                'flex-basis': '0px'
            });
        } else {
            if (wasHidden) {
                const geometry = this.expandedGeometry;
                this.setTabsCssProps({
                    width: geometry?.width ?? '',
                    'min-width': geometry?.minWidth ?? '',
                    'flex-grow': geometry?.flexGrow ?? '',
                    'flex-shrink': geometry?.flexShrink ?? '',
                    'flex-basis': geometry?.flexBasis ?? ''
                });
            }
            this.expandedGeometry = null;

            // Layout changes elsewhere (for example opening or resizing a sidebar) can
            // overwrite the root split's inline flex geometry. Reassert our fixed width
            // after every sync, except while the user is actively dragging our divider.
            if (!this.listResizeArmed && this.preferredListWidth !== null) {
                this.setFixedListWidth(this.preferredListWidth);
            }
        }

        tabsContainer.classList.toggle('nn-detached-list-pane-inactive', inactive);
        tabsContainer.classList.toggle('nn-detached-list-pane-collapsed', collapsed);
    }
}
