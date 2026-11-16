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

async function ensureFolders() {
  const { meta = {} } = await chrome.storage.local.get('meta');
  let { wallFolderId, trashFolderId } = meta;

  if (!(await bookmarkExists(wallFolderId)) || !(await bookmarkExists(trashFolderId))) {
    const tree = await chrome.bookmarks.getTree();
    const roots = tree[0].children;
    const bar = roots[0]; // 书签栏
    const other = roots[1]; // 其他书签

    if (!(await bookmarkExists(wallFolderId))) {
      const f = await chrome.bookmarks.create({ parentId: bar.id, title: WALL_TITLE });
      wallFolderId = f.id;
    }
    if (!(await bookmarkExists(trashFolderId))) {
      // 回收站放在"其他书签"下，不占书签栏位置
      const f = await chrome.bookmarks.create({ parentId: other.id, title: TRASH_TITLE });
      trashFolderId = f.id;
    }
    await chrome.storage.local.set({ meta: { wallFolderId, trashFolderId } });
  }
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
