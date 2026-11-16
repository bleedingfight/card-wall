// ===== 卡片墙 Card Wall - background service worker =====
// 职责：初始化书签文件夹、右键菜单收藏、书签删除时清理 tag 数据

const WALL_TITLE = '📌 卡片墙';
const TRASH_TITLE = '🗑 卡片墙回收站';

async function bookmarkExists(id) {
  try {
    await chrome.bookmarks.get(id);
    return true;
  } catch {
    return false;
  }
}

/* 同名根目录去重自愈：多个「📌 卡片墙」/回收站同名文件夹收敛为一个，
 * meta 记录且仍存在的优先，否则保留书签数量最多的；其余子节点并入后删除空壳。 */
async function dedupeRootFolders(rootId, title, preferredId) {
  const tree = await chrome.bookmarks.getTree();
  const root = tree[0].children.find((r) => r.id === rootId);
  const candidates = (root?.children || []).filter((n) => !n.url && n.title === title);
  if (candidates.length <= 1) return candidates[0]?.id || null;

  const countLinks = (nodes) =>
    nodes.reduce((s, n) => s + (n.url ? 1 : countLinks(n.children || [])), 0);
  const keep = [...candidates].sort((a, b) => {
    if (a.id === preferredId) return -1;
    if (b.id === preferredId) return 1;
    const ca = countLinks(a.children || []);
    const cb = countLinks(b.children || []);
    if (cb !== ca) return cb - ca;
    return Number(a.id) - Number(b.id);
  })[0];
  for (const o of candidates) {
    if (o.id === keep.id) continue;
    await mergeInto(o.id, keep.id);
  }
  return keep.id;
}

async function mergeInto(srcId, dstId) {
  const dstChildren = await chrome.bookmarks.getChildren(dstId);
  for (const c of await chrome.bookmarks.getChildren(srcId)) {
    if (!c.url) {
      const same = dstChildren.find((d) => !d.url && d.title === c.title);
      if (same) {
        await mergeInto(c.id, same.id);
        continue;
      }
    }
    await chrome.bookmarks.move(c.id, { parentId: dstId });
  }
  await chrome.bookmarks.removeTree(srcId);
}

async function ensureFolders() {
  const { meta = {} } = await chrome.storage.local.get('meta');
  const tree = await chrome.bookmarks.getTree();
  const roots = tree[0].children;
  const bar = roots[0]; // 书签栏
  const other = roots[1]; // 其他书签

  let wallFolderId = await dedupeRootFolders(bar.id, WALL_TITLE, meta.wallFolderId);
  let trashFolderId = await dedupeRootFolders(other.id, TRASH_TITLE, meta.trashFolderId);

  if (!wallFolderId) {
    wallFolderId = (await chrome.bookmarks.create({ parentId: bar.id, title: WALL_TITLE })).id;
  }
  if (!trashFolderId) {
    // 回收站放在"其他书签"下，不占书签栏位置
    trashFolderId = (await chrome.bookmarks.create({ parentId: other.id, title: TRASH_TITLE })).id;
  }
  await chrome.storage.local.set({ meta: { wallFolderId, trashFolderId } });
  return { wallFolderId, trashFolderId };
}

chrome.runtime.onInstalled.addListener(() => {
  ensureFolders();
  chrome.contextMenus.create({
    id: 'save-to-wall',
    title: '收藏到卡片墙',
    contexts: ['page', 'link'],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'save-to-wall') return;
  const url = info.linkUrl || info.pageUrl;
  const title = info.selectionText || tab?.title || url;
  if (!url || !/^https?:\/\//.test(url)) return;
  const { wallFolderId } = await ensureFolders();
  // 弹出独立小窗：展示卡片墙目录树，用户选择收藏位置
  chrome.windows.create({
    url:
      chrome.runtime.getURL('picker.html') +
      `?url=${encodeURIComponent(url)}&title=${encodeURIComponent(title || '')}&folder=${wallFolderId}`,
    type: 'popup',
    width: 380,
    height: 520,
  });
});

// 书签被删除（包括在回收站里被彻底删除）时，清理插件侧的 tag 数据
// cardTags 以 url 为 key（跨设备同步稳定），而非书签内部 id
chrome.bookmarks.onRemoved.addListener(async (id, removeInfo) => {
  const url = removeInfo?.node?.url;
  if (!url) return;
  const { cardTags = {} } = await chrome.storage.local.get('cardTags');
  if (cardTags[url]) {
    delete cardTags[url];
    await chrome.storage.local.set({ cardTags });
  }
});
