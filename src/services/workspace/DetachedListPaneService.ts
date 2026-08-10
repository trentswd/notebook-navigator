/*
 * Notebook Navigator - Plugin for Obsidian
 * Copyright (c) 2025-2026 Johan Sanneblad
 *
 * Local patch: host the horizontal desktop list pane in a companion sidebar.
 */

import { EventRef } from 'obsidian';
import type NotebookNavigatorPlugin from '../../main';
import { NOTEBOOK_NAVIGATOR_DETACHED_LIST_VIEW } from '../../types';
import { localStorage } from '../../utils/localStorage';

type HostListener = (host: HTMLElement | null) => void;

const DEFAULT_LIST_WIDTH = 420;
const MIN_LIST_WIDTH = 250;
const MIN_EDITOR_WIDTH = 320;

/**
 * Provides a second left-sidebar surface for the horizontal desktop layout.
 *
 * The companion is deliberately a plain DOM child of `.workspace`, not a
 * WorkspaceLeaf. Obsidian therefore never includes it in root-split resize,
 * leaf restoration, or drag/drop calculations.
 */
export class DetachedListPaneService {
    private readonly plugin: NotebookNavigatorPlugin;
    private host: HTMLElement | null = null;
    private companion: HTMLElement | null = null;
    private resizeHandle: HTMLElement | null = null;
    private listeners = new Set<HostListener>();
    private layoutEventRef: EventRef | null = null;
    private workspaceObserver: MutationObserver | null = null;
    private requestedActive = false;
    private navigationWidth = 300;
    private preferredListWidth = DEFAULT_LIST_WIDTH;
    private disposed = false;
    private hostWindow: Window | null = null;
    private resizePointerId: number | null = null;
    private resizeStartX = 0;
    private resizeStartWidth = 0;
    private resizeMaxWidth = DEFAULT_LIST_WIDTH;
    private adjustedLeftSplit: HTMLElement | null = null;
    private originalLeftSplitInlineWidth: string | null = null;
    private originalLeftSplitWidth: number | null = null;

    private readonly handlePointerMove = (event: PointerEvent): void => {
        if (event.pointerId !== this.resizePointerId || !this.companion) {
            return;
        }
        const nextWidth = this.clampListWidth(this.resizeStartWidth + event.clientX - this.resizeStartX, this.resizeMaxWidth);
        this.preferredListWidth = nextWidth;
        this.applyListWidth(nextWidth);
        event.preventDefault();
    };

    private readonly handlePointerUp = (event: PointerEvent): void => {
        if (event.pointerId !== this.resizePointerId) {
            return;
        }
        this.finishResize(true);
        event.preventDefault();
    };

    private readonly handlePointerCancel = (event: PointerEvent): void => {
        if (event.pointerId !== this.resizePointerId) {
            return;
        }
        this.finishResize(false);
    };

    constructor(plugin: NotebookNavigatorPlugin) {
        this.plugin = plugin;
        const storedWidth = localStorage.get<unknown>(plugin.keys.detachedListPaneWidthKey);
        if (typeof storedWidth === 'number' && Number.isFinite(storedWidth) && storedWidth >= MIN_LIST_WIDTH) {
            this.preferredListWidth = Math.round(storedWidth);
        }
    }

    start(): void {
        if (this.layoutEventRef) {
            return;
        }

        this.layoutEventRef = this.plugin.app.workspace.on('layout-change', () => {
            this.detachLegacyLeaves();
            this.ensurePlacement();
            this.syncVisibility();
        });

        const workspaceEl = activeDocument.querySelector<HTMLElement>('.workspace');
        if (workspaceEl) {
            this.workspaceObserver = new MutationObserver(() => {
                this.ensurePlacement();
                this.syncVisibility();
            });
            this.workspaceObserver.observe(workspaceEl, {
                attributes: true,
                attributeFilter: ['class'],
                childList: true
            });
        }

        this.detachLegacyLeaves();
    }

    dispose(): void {
        this.disposed = true;
        if (this.layoutEventRef) {
            this.plugin.app.workspace.offref(this.layoutEventRef);
            this.layoutEventRef = null;
        }
        this.workspaceObserver?.disconnect();
        this.workspaceObserver = null;
        this.finishResize(false);
        this.restoreLeftSplitWidth();
        this.removeCompanion();
        this.listeners.clear();
    }

    getHost(): HTMLElement | null {
        return this.host;
    }

    subscribe(listener: HostListener): () => void {
        this.listeners.add(listener);
        listener(this.host);
        return () => this.listeners.delete(listener);
    }

    /**
     * Compatibility hook for layouts saved by earlier revisions of this fork.
     * Legacy detached views are removed instead of becoming the portal host.
     */
    attachHost(_host: HTMLElement, _tabsContainer: HTMLElement | null): void {
        this.detachLegacyLeaves();
    }

    /** Compatibility hook paired with attachHost(). */
    detachHost(_host: HTMLElement): void {
        // The companion host has an independent lifecycle.
    }

    async setActive(active: boolean, navigationWidth: number): Promise<void> {
        this.requestedActive = active;
        if (Number.isFinite(navigationWidth) && navigationWidth > 0) {
            this.navigationWidth = Math.round(navigationWidth);
        }

        if (active) {
            this.ensureCompanion();
            this.applyNavigationWidth();
            this.detachLegacyLeaves();
        } else {
            this.restoreLeftSplitWidth();
        }
        this.syncVisibility();
    }

    private notifyHostListeners(): void {
        for (const listener of this.listeners) {
            listener(this.host);
        }
    }

    private getWorkspaceElement(doc: Document = activeDocument): HTMLElement | null {
        return doc.querySelector<HTMLElement>('.workspace');
    }

    private getLeftSplitElement(doc: Document = activeDocument): HTMLElement | null {
        return doc.querySelector<HTMLElement>('.workspace > .workspace-split.mod-left-split');
    }

    private getRootSplitElement(doc: Document = activeDocument): HTMLElement | null {
        return doc.querySelector<HTMLElement>('.workspace > .workspace-split.mod-root');
    }

    private ensureCompanion(): void {
        if (this.disposed) {
            return;
        }

        const doc = activeDocument;
        const workspaceEl = this.getWorkspaceElement(doc);
        const rootSplitEl = this.getRootSplitElement(doc);
        if (!workspaceEl || !rootSplitEl) {
            return;
        }

        if (this.companion?.isConnected && this.companion.parentElement === workspaceEl) {
            if (this.companion.nextElementSibling !== rootSplitEl) {
                workspaceEl.insertBefore(this.companion, rootSplitEl);
            }
            return;
        }

        this.removeCompanion();

        const companion = doc.win.createDiv({ cls: 'nn-companion-sidebar nn-companion-sidebar-inactive' });
        companion.setAttribute('role', 'complementary');
        companion.setAttribute('aria-label', 'Notebook navigator files');

        const header = doc.win.createDiv({ cls: 'nn-companion-sidebar-header' });
        header.setAttribute('aria-hidden', 'true');

        const host = doc.win.createDiv({
            cls: 'nn-companion-sidebar-content notebook-navigator notebook-navigator-detached-list-host'
        });

        const resizeHandle = doc.win.createDiv({ cls: 'nn-companion-sidebar-resize-handle' });
        resizeHandle.setAttribute('role', 'separator');
        resizeHandle.setAttribute('aria-orientation', 'vertical');
        resizeHandle.setAttribute('aria-label', 'Resize notebook navigator files');
        resizeHandle.addEventListener('pointerdown', event => this.startResize(event));

        companion.append(header, host, resizeHandle);
        companion.style.setProperty('--nn-companion-sidebar-width', `${this.preferredListWidth}px`);
        workspaceEl.insertBefore(companion, rootSplitEl);

        this.companion = companion;
        this.host = host;
        this.resizeHandle = resizeHandle;
        this.hostWindow = doc.defaultView;
        this.notifyHostListeners();
    }

    private ensurePlacement(): void {
        if (!this.requestedActive) {
            return;
        }
        this.ensureCompanion();
        const companion = this.companion;
        const rootSplitEl = companion ? this.getRootSplitElement(companion.ownerDocument) : null;
        if (companion && rootSplitEl && companion.nextElementSibling !== rootSplitEl) {
            rootSplitEl.parentElement?.insertBefore(companion, rootSplitEl);
        }
    }

    private removeCompanion(): void {
        if (this.host) {
            this.host = null;
            this.notifyHostListeners();
        }
        this.companion?.remove();
        this.companion = null;
        this.resizeHandle = null;
        this.hostWindow = null;
    }

    private applyNavigationWidth(): void {
        const companionDoc = this.companion?.ownerDocument ?? activeDocument;
        const leftSplitEl = this.getLeftSplitElement(companionDoc);
        if (!leftSplitEl) {
            return;
        }

        if (this.adjustedLeftSplit !== leftSplitEl) {
            this.restoreLeftSplitWidth();
            this.adjustedLeftSplit = leftSplitEl;
            this.originalLeftSplitInlineWidth = leftSplitEl.style.width;
            this.originalLeftSplitWidth = Math.round(leftSplitEl.getBoundingClientRect().width);
        }

        leftSplitEl.style.width = `${this.navigationWidth}px`;
    }

    private restoreLeftSplitWidth(): void {
        const leftSplitEl = this.adjustedLeftSplit;
        if (!leftSplitEl) {
            return;
        }

        if (this.originalLeftSplitInlineWidth) {
            leftSplitEl.style.width = this.originalLeftSplitInlineWidth;
        } else if (this.originalLeftSplitWidth && this.originalLeftSplitWidth > 0) {
            leftSplitEl.style.width = `${this.originalLeftSplitWidth}px`;
        } else {
            leftSplitEl.style.removeProperty('width');
        }

        this.adjustedLeftSplit = null;
        this.originalLeftSplitInlineWidth = null;
        this.originalLeftSplitWidth = null;
    }

    private startResize(event: PointerEvent): void {
        if (event.button !== 0 || !this.companion || this.companion.classList.contains('nn-companion-sidebar-hidden')) {
            return;
        }

        const hostWindow = this.hostWindow;
        const rootSplitEl = this.getRootSplitElement(this.companion.ownerDocument);
        if (!hostWindow || !rootSplitEl) {
            return;
        }

        this.finishResize(false);
        this.resizePointerId = event.pointerId;
        this.resizeStartX = event.clientX;
        this.resizeStartWidth = this.companion.getBoundingClientRect().width;
        this.resizeMaxWidth = Math.max(
            MIN_LIST_WIDTH,
            this.resizeStartWidth + rootSplitEl.getBoundingClientRect().width - MIN_EDITOR_WIDTH
        );
        this.companion.classList.add('nn-companion-sidebar-resizing');
        this.resizeHandle?.setAttribute('aria-valuenow', `${Math.round(this.resizeStartWidth)}`);
        hostWindow.addEventListener('pointermove', this.handlePointerMove, true);
        hostWindow.addEventListener('pointerup', this.handlePointerUp, true);
        hostWindow.addEventListener('pointercancel', this.handlePointerCancel, true);
        event.preventDefault();
        event.stopPropagation();
    }

    private finishResize(persist: boolean): void {
        const hostWindow = this.hostWindow;
        hostWindow?.removeEventListener('pointermove', this.handlePointerMove, true);
        hostWindow?.removeEventListener('pointerup', this.handlePointerUp, true);
        hostWindow?.removeEventListener('pointercancel', this.handlePointerCancel, true);
        this.resizePointerId = null;
        this.companion?.classList.remove('nn-companion-sidebar-resizing');

        if (persist) {
            localStorage.set(this.plugin.keys.detachedListPaneWidthKey, Math.round(this.preferredListWidth));
        }
    }

    private clampListWidth(requestedWidth: number, maxWidth = Number.POSITIVE_INFINITY): number {
        return Math.round(Math.min(Math.max(requestedWidth, MIN_LIST_WIDTH), Math.max(MIN_LIST_WIDTH, maxWidth)));
    }

    private getAvailableListWidth(): number {
        const companion = this.companion;
        const rootSplitEl = companion ? this.getRootSplitElement(companion.ownerDocument) : null;
        if (!companion || !rootSplitEl) {
            return this.preferredListWidth;
        }
        return Math.max(
            MIN_LIST_WIDTH,
            companion.getBoundingClientRect().width + rootSplitEl.getBoundingClientRect().width - MIN_EDITOR_WIDTH
        );
    }

    private applyListWidth(width: number): void {
        this.companion?.style.setProperty('--nn-companion-sidebar-width', `${Math.round(width)}px`);
        this.resizeHandle?.setAttribute('aria-valuenow', `${Math.round(width)}`);
    }

    private syncVisibility(): void {
        const companion = this.companion;
        if (!companion) {
            return;
        }

        const leftCollapsed = this.plugin.app.workspace.leftSplit.collapsed;
        const inactive = !this.requestedActive;
        const collapsed = this.requestedActive && leftCollapsed;
        const hidden = inactive || collapsed;

        if (!hidden) {
            this.applyListWidth(this.clampListWidth(this.preferredListWidth, this.getAvailableListWidth()));
        }
        companion.style.setProperty('--nn-pane-transition-duration', `${this.plugin.settings.paneTransitionDuration}ms`);
        companion.classList.toggle('nn-companion-sidebar-inactive', inactive);
        companion.classList.toggle('nn-companion-sidebar-collapsed', collapsed);
        companion.classList.toggle('nn-companion-sidebar-hidden', hidden);
        companion.setAttribute('aria-hidden', hidden ? 'true' : 'false');
        companion.toggleAttribute('inert', hidden);
    }

    private detachLegacyLeaves(): void {
        const leaves = this.plugin.app.workspace.getLeavesOfType(NOTEBOOK_NAVIGATOR_DETACHED_LIST_VIEW);
        if (leaves.length === 0) {
            return;
        }
        const hostWindow = this.hostWindow ?? activeWindow;
        hostWindow.setTimeout(() => {
            for (const leaf of leaves) {
                leaf.detach();
            }
            this.plugin.app.workspace.requestSaveLayout();
        }, 0);
    }
}

