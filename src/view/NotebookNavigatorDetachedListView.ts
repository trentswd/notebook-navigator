/*
 * Notebook Navigator - Plugin for Obsidian
 * Copyright (c) 2025-2026 Johan Sanneblad
 *
 * Local patch: workspace host for the detached desktop ListPane portal.
 */

import { ItemView, WorkspaceLeaf } from 'obsidian';
import type NotebookNavigatorPlugin from '../main';
import { NOTEBOOK_NAVIGATOR_ICON_ID } from '../constants/notebookNavigatorIcon';
import { NOTEBOOK_NAVIGATOR_DETACHED_LIST_VIEW } from '../types';
import { setupNotebookNavigatorViewContainer } from './NotebookNavigatorView';

export class NotebookNavigatorDetachedListView extends ItemView {
    private readonly plugin: NotebookNavigatorPlugin;
    private host: HTMLElement | null = null;
    private attachTimer: number | null = null;

    constructor(leaf: WorkspaceLeaf, plugin: NotebookNavigatorPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType(): string {
        return NOTEBOOK_NAVIGATOR_DETACHED_LIST_VIEW;
    }

    getDisplayText(): string {
        return 'Notebook navigator files';
    }

    getIcon(): string {
        return NOTEBOOK_NAVIGATOR_ICON_ID;
    }

    async onOpen(): Promise<void> {
        const container = this.containerEl.children[1];
        if (!container.instanceOf(HTMLElement)) {
            return;
        }
        setupNotebookNavigatorViewContainer(container);
        container.classList.add('notebook-navigator-detached-list-host');
        this.host = container;
        this.attachWhenMounted(container);
    }

    async onClose(): Promise<void> {
        if (this.attachTimer !== null) {
            window.clearTimeout(this.attachTimer);
            this.attachTimer = null;
        }
        const host = this.host;
        if (!host) {
            return;
        }
        this.plugin.detachDetachedListPaneHost(host);
        host.classList.remove('notebook-navigator-detached-list-host');
        this.host = null;
    }

    private attachWhenMounted(container: HTMLElement): void {
        const tabsContainer = this.containerEl.closest<HTMLElement>('.workspace-tabs');
        if (tabsContainer) {
            this.attachTimer = null;
            this.plugin.attachDetachedListPaneHost(container, tabsContainer);
            return;
        }

        this.attachTimer = window.setTimeout(() => {
            if (this.host === container) {
                this.attachWhenMounted(container);
            }
        }, 16);
    }
}

