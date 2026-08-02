/*
 * Notebook Navigator - Plugin for Obsidian
 * Copyright (c) 2025-2026 Johan Sanneblad
 *
 * Local patch: host the horizontal desktop list pane in a main-workspace leaf.
 */

import { EventRef, WorkspaceLeaf } from 'obsidian';
import type NotebookNavigatorPlugin from '../../main';
import { NOTEBOOK_NAVIGATOR_DETACHED_LIST_VIEW } from '../../types';
import { getLeafSplitLocation } from '../../utils/workspaceSplit';

type HostListener = (host: HTMLElement | null) => void;

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
    private readonly handlePointerUp = (): void => this.captureCurrentListWidth();
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
        this.hostWindow?.removeEventListener('pointerup', this.handlePointerUp, true);
        this.hostWindow = null;
        this.listeners.clear();
        if (this.geometryTimer !== null) {
            window.clearTimeout(this.geometryTimer);
            this.geometryTimer = null;
        }
        this.host = null;
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
        this.host = host;
        this.tabsContainer = tabsContainer;
        tabsContainer?.classList.add('nn-detached-list-workspace-tabs');
        this.hostWindow?.removeEventListener('pointerup', this.handlePointerUp, true);
        this.hostWindow = host.ownerDocument.defaultView;
        this.hostWindow?.addEventListener('pointerup', this.handlePointerUp, true);
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
        this.tabsContainer?.classList.remove(
            'nn-detached-list-workspace-tabs',
            'nn-detached-list-pane-collapsed',
            'nn-detached-list-pane-inactive'
        );
        this.hostWindow?.removeEventListener('pointerup', this.handlePointerUp, true);
        this.hostWindow = null;
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
        if (this.disposed || !this.requestedActive) {
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
        const existing = workspace.getLeavesOfType(NOTEBOOK_NAVIGATOR_DETACHED_LIST_VIEW)[0] ?? null;
        if (existing) {
            this.detachedLeaf = existing;
            await existing.loadIfDeferred();
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

        if (previouslyActive && previouslyActive !== leaf) {
            workspace.setActiveLeaf(previouslyActive, { focus: false });
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
            leftSplitEl.setCssProps({ width: `${Math.round(this.navigationWidth)}px` });
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
        return targetWidth;
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
        this.tabsContainer?.setCssProps(properties);
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
        } else if (!shouldHide && wasHidden) {
            const geometry = this.expandedGeometry;
            this.setTabsCssProps({
                width: geometry?.width ?? '',
                'min-width': geometry?.minWidth ?? '',
                'flex-grow': geometry?.flexGrow ?? '',
                'flex-shrink': geometry?.flexShrink ?? '',
                'flex-basis': geometry?.flexBasis ?? ''
            });
            this.expandedGeometry = null;
        }

        tabsContainer.classList.toggle('nn-detached-list-pane-inactive', inactive);
        tabsContainer.classList.toggle('nn-detached-list-pane-collapsed', collapsed);
    }
}
