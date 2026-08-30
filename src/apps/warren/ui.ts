import { wireDataMenu } from '../../lib/dataMenu';
import { downloadFile } from '../../lib/portable';
import { toast } from '../../lib/toast';
import {
  APP_ID,
  BLOCK_TYPES,
  ancestorsOf,
  buildTree,
  childrenOf,
  createBlock,
  createPage,
  descendantsOf,
  indentBlock,
  isList,
  livePages,
  movePage,
  orderedNumber,
  reorderPage,
  restorePage,
  search,
  shortcutFor,
  toMarkdown,
  touch,
  trashPage,
  trashedRoots,
  typeAfterEnter,
  wordCount,
  type Block,
  type BlockType,
  type Page,
  type TreeNode,
} from './model';
import {
  applyImport,
  buildExport,
  clearAll,
  deletePages,
  loadPages,
  loadView,
  savePage,
  savePages,
  saveView,
  type ViewPrefs,
} from './store';

export async function mountWarren(root: HTMLElement): Promise<void> {
  let pages: Page[] = [];
  let view: ViewPrefs = loadView();
  let saveTimer: number | undefined;

  const sidebar = root.querySelector<HTMLElement>('#wr-sidebar')!;
  const treeList = root.querySelector<HTMLElement>('#wr-tree')!;
  const trashList = root.querySelector<HTMLElement>('#wr-trash')!;
  const trashPanel = root.querySelector<HTMLElement>('#wr-trash-panel')!;
  const trashToggle = root.querySelector<HTMLButtonElement>('#wr-trash-toggle')!;
  const editor = root.querySelector<HTMLElement>('#wr-editor')!;
  const crumbs = root.querySelector<HTMLElement>('#wr-crumbs')!;
  const titleInput = root.querySelector<HTMLInputElement>('#wr-title')!;
  const iconButton = root.querySelector<HTMLButtonElement>('#wr-icon')!;
  const blockList = root.querySelector<HTMLElement>('#wr-blocks')!;
  const meta = root.querySelector<HTMLElement>('#wr-meta')!;
  const childStrip = root.querySelector<HTMLElement>('#wr-children')!;
  const searchInput = root.querySelector<HTMLInputElement>('#wr-search')!;
  const searchResults = root.querySelector<HTMLElement>('#wr-search-results')!;
  const emptyState = root.querySelector<HTMLElement>('#wr-empty')!;
  const sidebarToggle = root.querySelector<HTMLButtonElement>('#wr-sidebar-toggle')!;
  const slashMenu = root.querySelector<HTMLElement>('#wr-slash')!;

  let slashBlockId: string | null = null;

  const currentPage = (): Page | null => pages.find((page) => page.id === view.openPageId && !page.trashedAt) ?? null;

  function persistSoon(page: Page): void {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => { void savePage(page); }, 250);
  }

  function updatePage(changes: Partial<Page>, options: { rerender?: boolean; immediate?: boolean } = {}): Page | null {
    const page = currentPage();
    if (!page) return null;
    const next = touch(page, changes);
    pages = pages.map((item) => (item.id === next.id ? next : item));
    if (options.immediate) void savePage(next);
    else persistSoon(next);
    if (options.rerender !== false) renderEditor();
    renderTree();
    return next;
  }

  // --------------------------------------------------------------- sidebar
  function treeRow(node: TreeNode): HTMLElement {
    const { page, depth, children } = node;
    const row = document.createElement('div');
    row.className = 'wr-row';
    row.style.setProperty('--depth', String(depth));
    if (page.id === view.openPageId) row.dataset.current = 'true';

    const twist = document.createElement('button');
    twist.type = 'button';
    twist.className = 'wr-row__twist';
    twist.dataset.toggleCollapse = page.id;
    twist.setAttribute('aria-label', page.collapsed ? `Expand ${page.title || 'Untitled'}` : `Collapse ${page.title || 'Untitled'}`);
    twist.textContent = children.length ? (page.collapsed ? '▸' : '▾') : '';
    twist.disabled = children.length === 0;

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'wr-row__open';
    open.dataset.openPage = page.id;
    open.innerHTML = `<span class="wr-row__icon">${page.icon || '·'}</span><span class="wr-row__title"></span>`;
    open.querySelector('.wr-row__title')!.textContent = page.title || 'Untitled';

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'wr-row__action';
    add.dataset.addChild = page.id;
    add.textContent = '+';
    add.title = 'Add a page inside this one';

    const menu = document.createElement('button');
    menu.type = 'button';
    menu.className = 'wr-row__action';
    menu.dataset.pageMenu = page.id;
    menu.textContent = '⋯';
    menu.title = 'Move, rename, or trash this page';

    row.append(twist, open, add, menu);
    return row;
  }

  function renderTree(): void {
    treeList.innerHTML = '';

    const walk = (nodes: TreeNode[]) => {
      for (const node of nodes) {
        treeList.appendChild(treeRow(node));
        if (!node.page.collapsed) walk(node.children);
      }
    };
    walk(buildTree(pages));

    if (livePages(pages).length === 0) {
      const blank = document.createElement('p');
      blank.className = 'wr-sidebar__blank';
      blank.textContent = 'No pages yet.';
      treeList.appendChild(blank);
    }

    const binned = trashedRoots(pages);
    trashToggle.textContent = `Trash (${binned.length})`;
    trashPanel.hidden = !view.showTrash;
    trashToggle.setAttribute('aria-expanded', String(view.showTrash));

    trashList.innerHTML = '';
    if (view.showTrash) {
      if (!binned.length) {
        const blank = document.createElement('p');
        blank.className = 'wr-sidebar__blank';
        blank.textContent = 'The trash is empty.';
        trashList.appendChild(blank);
      }
      for (const page of binned) {
        const row = document.createElement('div');
        row.className = 'wr-trash-row';
        const name = document.createElement('span');
        name.textContent = `${page.icon || '·'} ${page.title || 'Untitled'}`;
        const restore = document.createElement('button');
        restore.type = 'button';
        restore.dataset.restorePage = page.id;
        restore.textContent = 'Restore';
        const purge = document.createElement('button');
        purge.type = 'button';
        purge.dataset.purgePage = page.id;
        purge.textContent = 'Delete';
        purge.className = 'is-danger';
        row.append(name, restore, purge);
        trashList.appendChild(row);
      }
    }

    root.dataset.sidebar = view.sidebarOpen ? 'open' : 'closed';
    sidebarToggle.setAttribute('aria-expanded', String(view.sidebarOpen));
  }

  // --------------------------------------------------------------- editor
  function blockElement(block: Block, index: number, blocks: Block[]): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'wr-block';
    wrapper.dataset.blockId = block.id;
    wrapper.dataset.type = block.type;
    wrapper.style.setProperty('--indent', String(block.indent));

    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'wr-block__handle';
    handle.dataset.blockMenu = block.id;
    handle.textContent = '⠿';
    handle.title = 'Change this block';
    handle.setAttribute('aria-label', 'Change this block');
    wrapper.appendChild(handle);

    if (block.type === 'divider') {
      const rule = document.createElement('hr');
      rule.className = 'wr-divider';
      wrapper.appendChild(rule);
      return wrapper;
    }

    if (block.type === 'todo') {
      const box = document.createElement('button');
      box.type = 'button';
      box.className = 'wr-check';
      box.dataset.toggleCheck = block.id;
      box.setAttribute('role', 'checkbox');
      box.setAttribute('aria-checked', String(block.checked));
      wrapper.appendChild(box);
    }

    if (block.type === 'bulleted') {
      const dot = document.createElement('span');
      dot.className = 'wr-bullet';
      dot.setAttribute('aria-hidden', 'true');
      wrapper.appendChild(dot);
    }

    if (block.type === 'numbered') {
      const number = document.createElement('span');
      number.className = 'wr-number';
      number.setAttribute('aria-hidden', 'true');
      number.textContent = `${orderedNumber(blocks, index)}.`;
      wrapper.appendChild(number);
    }

    const input = document.createElement('div');
    input.className = 'wr-block__text';
    input.contentEditable = 'true';
    input.spellcheck = block.type !== 'code';
    input.dataset.blockInput = block.id;
    input.setAttribute('role', 'textbox');
    input.setAttribute('aria-multiline', 'false');
    input.textContent = block.text;
    if (!block.text) input.dataset.placeholder = placeholderFor(block.type, index === 0);
    wrapper.appendChild(input);

    return wrapper;
  }

  function placeholderFor(type: BlockType, first: boolean): string {
    if (type === 'code') return 'Code';
    if (type === 'quote') return 'Quote';
    if (type === 'callout') return 'Something worth noticing';
    if (type === 'heading1' || type === 'heading2' || type === 'heading3') return 'Heading';
    if (isList(type)) return 'List item';
    return first ? "Start writing. Type / for blocks, or use markdown shortcuts like # and -." : "Type / for blocks";
  }

  function renderEditor(): void {
    const page = currentPage();
    editor.hidden = !page;
    emptyState.hidden = Boolean(page);
    if (!page) return;

    crumbs.innerHTML = '';
    const trail = ancestorsOf(pages, page.id);
    trail.forEach((item, index) => {
      if (index > 0) {
        const sep = document.createElement('span');
        sep.className = 'wr-crumb-sep';
        sep.textContent = '/';
        crumbs.appendChild(sep);
      }
      const crumb = document.createElement('button');
      crumb.type = 'button';
      crumb.className = 'wr-crumb';
      crumb.dataset.openPage = item.id;
      crumb.textContent = `${item.icon ? `${item.icon} ` : ''}${item.title || 'Untitled'}`;
      if (index === trail.length - 1) crumb.disabled = true;
      crumbs.appendChild(crumb);
    });

    iconButton.textContent = page.icon || '＋';
    iconButton.title = page.icon ? 'Change the icon' : 'Add an icon';
    if (document.activeElement !== titleInput) titleInput.value = page.title;

    const focusedId = (document.activeElement as HTMLElement | null)?.dataset?.blockInput;
    const caret = focusedId ? getCaretOffset(document.activeElement as HTMLElement) : null;

    blockList.innerHTML = '';
    page.blocks.forEach((block, index) => blockList.appendChild(blockElement(block, index, page.blocks)));

    if (focusedId) {
      const restored = blockList.querySelector<HTMLElement>(`[data-block-input="${focusedId}"]`);
      if (restored) {
        restored.focus();
        if (caret !== null) setCaretOffset(restored, caret);
      }
    }

    const words = wordCount(page);
    const kids = childrenOf(pages, page.id);
    meta.textContent = [
      `${page.blocks.length} block${page.blocks.length === 1 ? '' : 's'}`,
      `${words} word${words === 1 ? '' : 's'}`,
      `edited ${new Date(page.updatedAt).toLocaleString()}`,
    ].join(' · ');

    childStrip.innerHTML = '';
    childStrip.hidden = kids.length === 0;
    if (kids.length) {
      const heading = document.createElement('h2');
      heading.className = 'wr-subhead';
      heading.textContent = `Pages inside (${kids.length})`;
      childStrip.appendChild(heading);
      const grid = document.createElement('div');
      grid.className = 'wr-children__grid';
      for (const child of kids) {
        const link = document.createElement('button');
        link.type = 'button';
        link.className = 'wr-child';
        link.dataset.openPage = child.id;
        link.innerHTML = `<span>${child.icon || '📄'}</span>`;
        const name = document.createElement('strong');
        name.textContent = child.title || 'Untitled';
        link.appendChild(name);
        grid.appendChild(link);
      }
      childStrip.appendChild(grid);
    }
  }

  // ------------------------------------------------------- caret helpers
  function getCaretOffset(element: HTMLElement): number {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return 0;
    const range = selection.getRangeAt(0).cloneRange();
    range.selectNodeContents(element);
    range.setEnd(selection.getRangeAt(0).endContainer, selection.getRangeAt(0).endOffset);
    return range.toString().length;
  }

  function setCaretOffset(element: HTMLElement, offset: number): void {
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    const node = element.firstChild ?? element;
    const max = element.textContent?.length ?? 0;
    const position = Math.min(offset, max);
    try {
      if (node.nodeType === Node.TEXT_NODE) range.setStart(node, position);
      else range.setStart(element, 0);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    } catch {
      /* the node moved out from under us; leaving the caret where it is, is fine */
    }
  }

  function focusBlock(blockId: string, atEnd = true): void {
    const element = blockList.querySelector<HTMLElement>(`[data-block-input="${blockId}"]`);
    if (!element) return;
    element.focus();
    setCaretOffset(element, atEnd ? element.textContent?.length ?? 0 : 0);
  }

  // ------------------------------------------------------- block editing
  function withBlocks(mutate: (blocks: Block[]) => Block[], options: { rerender?: boolean } = {}): void {
    const page = currentPage();
    if (!page) return;
    updatePage({ blocks: mutate(page.blocks) }, options);
  }

  blockList.addEventListener('input', (event) => {
    const target = event.target as HTMLElement;
    const blockId = target.dataset.blockInput;
    if (!blockId) return;

    const page = currentPage();
    if (!page) return;
    const text = target.textContent ?? '';
    const block = page.blocks.find((item) => item.id === blockId);
    if (!block) return;

    // A markdown prefix converts the block as soon as it is complete.
    const shortcut = block.type === 'paragraph' ? shortcutFor(text) : null;
    if (shortcut) {
      withBlocks((blocks) =>
        blocks.map((item) =>
          item.id === blockId
            ? { ...item, type: shortcut.type, text: shortcut.rest, checked: /\[x\]/i.test(text) }
            : item,
        ),
      );
      window.requestAnimationFrame(() => focusBlock(blockId));
      return;
    }

    // Ordinary typing: no re-render, so the caret stays put.
    const next = page.blocks.map((item) => (item.id === blockId ? { ...item, text } : item));
    const updated = touch(page, { blocks: next });
    pages = pages.map((item) => (item.id === updated.id ? updated : item));
    persistSoon(updated);
    if (text) delete target.dataset.placeholder;
    else target.dataset.placeholder = placeholderFor(block.type, page.blocks[0]?.id === blockId);
  });

  blockList.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement;
    const blockId = target.dataset.blockInput;
    if (!blockId) return;

    const page = currentPage();
    if (!page) return;
    const index = page.blocks.findIndex((item) => item.id === blockId);
    const block = page.blocks[index];
    if (!block) return;

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (slashMenu.hidden === false) return;

      // Enter on an empty list item ends the list rather than adding another.
      if (isList(block.type) && !block.text.trim()) {
        withBlocks((blocks) => blocks.map((item) => (item.id === blockId ? { ...item, type: 'paragraph', indent: 0 } : item)));
        window.requestAnimationFrame(() => focusBlock(blockId));
        return;
      }

      const caret = getCaretOffset(target);
      const text = target.textContent ?? '';
      const before = text.slice(0, caret);
      const after = text.slice(caret);
      const fresh = createBlock(typeAfterEnter(block.type), after);
      fresh.indent = isList(block.type) ? block.indent : 0;

      withBlocks((blocks) => {
        const next = blocks.map((item) => (item.id === blockId ? { ...item, text: before } : item));
        next.splice(index + 1, 0, fresh);
        return next;
      });
      window.requestAnimationFrame(() => focusBlock(fresh.id, false));
      return;
    }

    if (event.key === 'Backspace' && getCaretOffset(target) === 0) {
      if (block.indent > 0 && isList(block.type)) {
        event.preventDefault();
        withBlocks((blocks) => indentBlock(blocks, blockId, -1));
        window.requestAnimationFrame(() => focusBlock(blockId, false));
        return;
      }
      if (block.type !== 'paragraph') {
        event.preventDefault();
        withBlocks((blocks) => blocks.map((item) => (item.id === blockId ? { ...item, type: 'paragraph' } : item)));
        window.requestAnimationFrame(() => focusBlock(blockId, false));
        return;
      }
      if (index > 0) {
        event.preventDefault();
        const previous = page.blocks[index - 1];
        const joinAt = previous.text.length;
        withBlocks((blocks) =>
          blocks
            .map((item) => (item.id === previous.id ? { ...item, text: previous.text + block.text } : item))
            .filter((item) => item.id !== blockId),
        );
        window.requestAnimationFrame(() => {
          const element = blockList.querySelector<HTMLElement>(`[data-block-input="${previous.id}"]`);
          if (element) { element.focus(); setCaretOffset(element, joinAt); }
        });
      }
      return;
    }

    if (event.key === 'Tab') {
      event.preventDefault();
      if (!isList(block.type)) return;
      withBlocks((blocks) => indentBlock(blocks, blockId, event.shiftKey ? -1 : 1));
      window.requestAnimationFrame(() => focusBlock(blockId));
      return;
    }

    if (event.key === 'ArrowUp' && getCaretOffset(target) === 0 && index > 0) {
      event.preventDefault();
      focusBlock(page.blocks[index - 1].id);
      return;
    }

    if (event.key === 'ArrowDown' && getCaretOffset(target) === (target.textContent?.length ?? 0) && index < page.blocks.length - 1) {
      event.preventDefault();
      focusBlock(page.blocks[index + 1].id, false);
      return;
    }

    if (event.key === '/' && !target.textContent) {
      window.requestAnimationFrame(() => openSlashMenu(blockId, target));
    }

    if (event.key === 'Escape') closeSlashMenu();
  });

  blockList.addEventListener('paste', (event) => {
    const target = event.target as HTMLElement;
    if (!target.dataset.blockInput) return;
    event.preventDefault();
    const text = event.clipboardData?.getData('text/plain') ?? '';
    document.execCommand('insertText', false, text.replace(/\r/g, ''));
  });

  blockList.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-toggle-check], [data-block-menu]');
    if (!target) return;

    if (target.dataset.toggleCheck) {
      withBlocks((blocks) => blocks.map((item) => (item.id === target.dataset.toggleCheck ? { ...item, checked: !item.checked } : item)));
      return;
    }

    if (target.dataset.blockMenu) openSlashMenu(target.dataset.blockMenu, target);
  });

  // ------------------------------------------------------- slash menu
  function openSlashMenu(blockId: string, anchor: HTMLElement): void {
    slashBlockId = blockId;
    slashMenu.innerHTML = '';

    for (const type of BLOCK_TYPES) {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'wr-slash__item';
      option.dataset.setType = type.id;
      option.innerHTML = `<strong></strong><span></span>`;
      option.querySelector('strong')!.textContent = type.label;
      option.querySelector('span')!.textContent = type.hint;
      slashMenu.appendChild(option);
    }

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'wr-slash__item wr-slash__item--danger';
    remove.dataset.deleteBlock = blockId;
    remove.innerHTML = '<strong>Delete block</strong><span>Remove this line</span>';
    slashMenu.appendChild(remove);

    const box = anchor.getBoundingClientRect();
    const editorBox = editor.getBoundingClientRect();
    slashMenu.hidden = false;
    slashMenu.style.top = `${box.bottom - editorBox.top + 6}px`;
    slashMenu.style.left = `${Math.max(0, box.left - editorBox.left)}px`;
  }

  function closeSlashMenu(): void {
    slashMenu.hidden = true;
    slashBlockId = null;
  }

  slashMenu.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-set-type], [data-delete-block]');
    if (!target || !slashBlockId) return;
    const blockId = slashBlockId;

    if (target.dataset.deleteBlock) {
      const page = currentPage();
      if (page && page.blocks.length > 1) {
        withBlocks((blocks) => blocks.filter((item) => item.id !== blockId));
      } else {
        withBlocks((blocks) => blocks.map((item) => (item.id === blockId ? { ...item, text: '', type: 'paragraph' } : item)));
      }
      closeSlashMenu();
      return;
    }

    const type = target.dataset.setType as BlockType;
    withBlocks((blocks) =>
      blocks.map((item) =>
        item.id === blockId
          ? { ...item, type, text: item.text.replace(/^\/$/, ''), indent: isList(type) ? item.indent : 0 }
          : item,
      ),
    );
    closeSlashMenu();
    window.requestAnimationFrame(() => focusBlock(blockId));
  });

  document.addEventListener('click', (event) => {
    if (slashMenu.hidden) return;
    if (!slashMenu.contains(event.target as Node) && !(event.target as HTMLElement).dataset?.blockMenu) closeSlashMenu();
  });

  // ------------------------------------------------------- page level
  titleInput.addEventListener('input', () => { updatePage({ title: titleInput.value }, { rerender: false }); });

  iconButton.addEventListener('click', () => {
    const page = currentPage();
    if (!page) return;
    const answer = window.prompt('Page icon (one emoji, or leave blank to remove)', page.icon);
    if (answer === null) return;
    updatePage({ icon: answer.trim().slice(0, 4) }, { immediate: true });
  });

  root.querySelector('#wr-new-page')?.addEventListener('click', async () => {
    const page = createPage(null, '');
    page.rank = childrenOf(pages, null).length + 1;
    pages = [...pages, page];
    await savePage(page);
    openPage(page.id);
  });

  root.querySelector('#wr-add-block')?.addEventListener('click', () => {
    const page = currentPage();
    if (!page) return;
    const fresh = createBlock();
    withBlocks((blocks) => [...blocks, fresh]);
    window.requestAnimationFrame(() => focusBlock(fresh.id));
  });

  root.querySelector('#wr-export-md')?.addEventListener('click', () => {
    const page = currentPage();
    if (!page) { toast('Open a page first.', { kind: 'error' }); return; }
    const name = (page.title || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    downloadFile(`${name || 'page'}.md`, toMarkdown(page, pages), 'text/markdown');
    toast('Markdown saved, including any pages inside this one.', { kind: 'good' });
  });

  function openPage(id: string): void {
    view = { ...view, openPageId: id };
    saveView(view);
    closeSlashMenu();
    searchInput.value = '';
    searchResults.hidden = true;
    renderTree();
    renderEditor();
    if (window.matchMedia('(max-width: 860px)').matches) {
      view = { ...view, sidebarOpen: false };
      saveView(view);
      renderTree();
    }
    titleInput.focus();
  }

  sidebar.addEventListener('click', async (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>(
      '[data-open-page], [data-add-child], [data-toggle-collapse], [data-page-menu], [data-restore-page], [data-purge-page]',
    );
    if (!target) return;

    if (target.dataset.openPage) { openPage(target.dataset.openPage); return; }

    if (target.dataset.toggleCollapse) {
      const id = target.dataset.toggleCollapse;
      pages = pages.map((page) => (page.id === id ? { ...page, collapsed: !page.collapsed } : page));
      const changed = pages.find((page) => page.id === id);
      if (changed) await savePage(changed);
      renderTree();
      return;
    }

    if (target.dataset.addChild) {
      const parentId = target.dataset.addChild;
      const page = createPage(parentId, '');
      page.rank = childrenOf(pages, parentId).length + 1;
      pages = [...pages, page];
      const parent = pages.find((item) => item.id === parentId);
      if (parent?.collapsed) {
        pages = pages.map((item) => (item.id === parentId ? { ...item, collapsed: false } : item));
        await savePage({ ...parent, collapsed: false });
      }
      await savePage(page);
      openPage(page.id);
      return;
    }

    if (target.dataset.pageMenu) { await pageMenu(target.dataset.pageMenu); return; }

    if (target.dataset.restorePage) {
      pages = restorePage(pages, target.dataset.restorePage);
      await savePages(pages.filter((page) => page.trashedAt === null));
      renderTree();
      renderEditor();
      toast('Restored.', { kind: 'good' });
      return;
    }

    if (target.dataset.purgePage) {
      const id = target.dataset.purgePage;
      const branch = [id, ...descendantsOf(pages, id).map((page) => page.id)];
      const page = pages.find((item) => item.id === id);
      const label = page?.title || 'Untitled';
      if (!window.confirm(`Delete "${label}"${branch.length > 1 ? ` and the ${branch.length - 1} page${branch.length === 2 ? '' : 's'} inside it` : ''} for good? This cannot be undone.`)) return;
      await deletePages(branch);
      pages = pages.filter((item) => !branch.includes(item.id));
      if (branch.includes(view.openPageId ?? '')) { view = { ...view, openPageId: null }; saveView(view); }
      renderTree();
      renderEditor();
    }
  });

  async function pageMenu(pageId: string): Promise<void> {
    const page = pages.find((item) => item.id === pageId);
    if (!page) return;

    const choice = window.prompt(
      [
        `"${page.title || 'Untitled'}"`,
        '',
        'Type a number:',
        '1  rename',
        '2  move up among its siblings',
        '3  move down among its siblings',
        '4  move to the top level',
        '5  move inside another page',
        '6  move to the trash',
      ].join('\n'),
      '1',
    );

    if (choice === '1') {
      const name = window.prompt('Page title', page.title);
      if (name === null) return;
      pages = pages.map((item) => (item.id === pageId ? touch(item, { title: name }) : item));
      await savePage(pages.find((item) => item.id === pageId)!);
    } else if (choice === '2' || choice === '3') {
      pages = reorderPage(pages, pageId, choice === '2' ? 'up' : 'down');
      await savePage(pages.find((item) => item.id === pageId)!);
    } else if (choice === '4') {
      pages = movePage(pages, pageId, null);
      await savePage(pages.find((item) => item.id === pageId)!);
    } else if (choice === '5') {
      const candidates = livePages(pages).filter((item) => item.id !== pageId);
      const listing = candidates.map((item, index) => `${index + 1}  ${item.title || 'Untitled'}`).join('\n');
      const answer = window.prompt(`Move inside which page?\n\n${listing}`, '1');
      const target = candidates[Number(answer) - 1];
      if (!target) return;
      const before = pages;
      pages = movePage(pages, pageId, target.id);
      if (pages === before) { toast('A page cannot be moved inside itself.', { kind: 'error' }); return; }
      await savePage(pages.find((item) => item.id === pageId)!);
    } else if (choice === '6') {
      const branchSize = descendantsOf(pages, pageId).length;
      pages = trashPage(pages, pageId);
      await savePages(pages.filter((item) => item.trashedAt !== null));
      if (view.openPageId === pageId) { view = { ...view, openPageId: null }; saveView(view); }
      toast(`Moved to the trash${branchSize ? ` with ${branchSize} page${branchSize === 1 ? '' : 's'} inside` : ''}.`, {
        actionLabel: 'Undo',
        onAction: async () => {
          pages = restorePage(pages, pageId);
          await savePages(pages.filter((item) => item.trashedAt === null));
          renderTree();
          renderEditor();
        },
      });
    } else {
      return;
    }

    renderTree();
    renderEditor();
  }

  // ------------------------------------------------------- search
  searchInput.addEventListener('input', () => {
    const query = searchInput.value;
    const hits = search(pages, query);
    searchResults.hidden = !query.trim();
    searchResults.innerHTML = '';

    if (!query.trim()) return;

    if (!hits.length) {
      const blank = document.createElement('p');
      blank.className = 'wr-sidebar__blank';
      blank.textContent = 'Nothing matches.';
      searchResults.appendChild(blank);
      return;
    }

    for (const hit of hits) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'wr-hit';
      row.dataset.openPage = hit.page.id;
      const title = document.createElement('strong');
      title.textContent = `${hit.page.icon || '·'} ${hit.page.title || 'Untitled'}`;
      const snippet = document.createElement('span');
      snippet.textContent = hit.where === 'body' ? hit.snippet : 'matches the title';
      row.append(title, snippet);
      searchResults.appendChild(row);
    }
  });

  searchResults.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-open-page]');
    if (target?.dataset.openPage) openPage(target.dataset.openPage);
  });

  sidebarToggle.addEventListener('click', () => {
    view = { ...view, sidebarOpen: !view.sidebarOpen };
    saveView(view);
    renderTree();
  });

  trashToggle.addEventListener('click', () => {
    view = { ...view, showTrash: !view.showTrash };
    saveView(view);
    renderTree();
  });

  document.addEventListener('keydown', (event) => {
    const typing = ['INPUT', 'TEXTAREA'].includes((document.activeElement as HTMLElement)?.tagName)
      || (document.activeElement as HTMLElement)?.isContentEditable;
    if ((event.ctrlKey || event.metaKey) && event.key === 'k') {
      event.preventDefault();
      if (!view.sidebarOpen) { view = { ...view, sidebarOpen: true }; saveView(view); renderTree(); }
      searchInput.focus();
      return;
    }
    if (event.key === '/' && !typing) { event.preventDefault(); searchInput.focus(); }
  });

  wireDataMenu(root, {
    app: APP_ID,
    buildExport: () => buildExport(),
    applyImport: async (text, mode) => {
      const count = await applyImport(text, mode);
      return `Imported. You now have ${count} page${count === 1 ? '' : 's'}.`;
    },
    onImported: async () => {
      pages = await loadPages();
      if (!pages.some((page) => page.id === view.openPageId && !page.trashedAt)) {
        view = { ...view, openPageId: childrenOf(pages, null)[0]?.id ?? null };
        saveView(view);
      }
      renderTree();
      renderEditor();
    },
    onClearAll: async () => {
      await clearAll();
      pages = [];
      view = { ...view, openPageId: null };
      saveView(view);
    },
    clearWarning: 'This deletes every page Warren has stored on this device, including the trash. Export first if you want a copy. Continue?',
  });

  pages = await loadPages();
  if (!pages.some((page) => page.id === view.openPageId && !page.trashedAt)) {
    view = { ...view, openPageId: childrenOf(pages, null)[0]?.id ?? null };
    saveView(view);
  }
  renderTree();
  renderEditor();
}
