/* ===== 卡片墙 Card Wall - 新标签页逻辑 =====
 *
 * 数据模型：
 * - 页面按书签大类（子文件夹）分组展示：每个分组卡片内嵌套收藏小卡片；
 *   卡片墙根目录下直接放的书签归入「未分类」组
 * - 卡片 = 「📌 卡片墙」书签文件夹里的真实书签（删除卡片 = 移动书签到回收站文件夹）
 * - 回收站 = 「其他书签」下的「🗑 卡片墙回收站」书签文件夹（随 Chrome 账号同步）
 * - tag = 插件私有数据，存 chrome.storage.local，以书签 URL 为 key
 *   （Chrome 书签同步后同一书签在每台设备内部 id 不同，URL 才是稳定主键）
 * - WebDAV 同步：tag 配置 + 背景设置，与浏览器书签同步互不冲突
 */
const $ = (s) => document.querySelector(s);

const GRADIENTS = {
  aurora: 'linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%)',
  sunset: 'linear-gradient(135deg, #ff9966 0%, #ff5e62 100%)',
  ocean: 'linear-gradient(135deg, #2193b0 0%, #6dd5ed 100%)',
  forest: 'linear-gradient(135deg, #134e5e 0%, #71b280 100%)',
  night: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)',
};

const SYNC_FILE = 'card-wall-sync.json';
const ROOT_GROUP_ID = '__root__';
const BING_API = 'https://cn.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1';
const DAILY_RANDOM_URL = 'https://picsum.photos/seed/{date}/1920/1080'; // 按日期做种子，同一天固定

function todayStr() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

let wallFolderId = null;
let trashFolderId = null;
let cardTags = {};   // { [url]: { tags: string[], deletedAt?: number } }
let settings = {};   // { sidebarCollapsed, bg, layoutN, collapsedGroups }
let encConfig = null; // WebDAV 配置密文 { v, salt, iv, ct }（AES-256-GCM，口令不落盘）
let groups = [];     // [{ id, title, items: [{ id, title, url }] }]（顶层分组，拍平用于主区展示）
let wallTreeData = []; // 侧边栏目录树：完整保留嵌套层级
let focusGroup = null; // 树节点聚焦的分组（可以是任意层级的文件夹）
let trashCards = []; // 回收站书签
let view = { mode: 'wall', group: null, tag: null, q: '' }; // mode: 'wall' | 'trash'
let editingUrl = null;
let groupPages = {}; // 每个分组的当前页码 { [groupId]: pageIndex }
let dragState = null; // 拖拽中的卡片 { card, isTrash }；拖目录树文件夹时额外带 { isFolder: true, descendantIds: Set }
let treeExpandTimer = null;  // 拖拽悬停自动展开目录的定时器
let treeExpandTarget = null; // 待自动展开的文件夹 id

// macOS Finder 式拖拽悬停展开：悬停折叠目录约 0.6s 后自动展开，可继续往深层拖
function scheduleTreeExpand(node) {
  if ((settings.treeExpanded || []).includes(node.id)) return;
  if (treeExpandTarget === node.id) return;
  cancelTreeExpand();
  treeExpandTarget = node.id;
  treeExpandTimer = setTimeout(async () => {
    treeExpandTimer = null;
    treeExpandTarget = null;
    settings.treeExpanded = [...(settings.treeExpanded || []), node.id];
    await saveSettings();
    // 关键：拖拽进行中不能整树重渲染（会销毁拖拽源导致浏览器中止拖拽），
    // 必须就地插入子节点行
    expandTreeNodeInPlace(node);
  }, 600);
}

// 就地展开：找到该目录的行，把子节点行插到它后面，不重建任何已有 DOM
function expandTreeNodeInPlace(node) {
  const row = document.querySelector(`.tree-row[data-id="${node.id}"]`);
  if (!row) return;
  // 已有更深缩进的兄弟行 = 子节点已插入过，避免重复
  const next = row.nextElementSibling;
  if (next && next.classList.contains('tree-row')) {
    const cur = parseFloat(getComputedStyle(row).paddingLeft);
    if (parseFloat(getComputedStyle(next).paddingLeft) > cur) return;
  }
  row.querySelector('.chev').textContent = '▾';
  const depth = Math.round((parseFloat(getComputedStyle(row).paddingLeft) - 8) / 14);
  const temp = document.createElement('div');
  renderTreeNodes(node.children, depth + 1, temp);
  row.after(...temp.childNodes);
}

function cancelTreeExpand() {
  if (treeExpandTimer) {
    clearTimeout(treeExpandTimer);
    treeExpandTimer = null;
  }
  treeExpandTarget = null;
}

// 把书签移动到指定文件夹（追加到末尾）；已在同目录则忽略
async function moveToFolder(card, folderId) {
  try {
    const [info] = await chrome.bookmarks.get(card.id);
    if (info.parentId === folderId) return;
    await chrome.bookmarks.move(card.id, { parentId: folderId });
    await loadAll();
    renderAll();
  } catch {
    /* 书签已被删除等情况，忽略 */
  }
}

function clearTreeDropHovers() {
  document.querySelectorAll('.tree-row').forEach((el) =>
    el.classList.remove('drop-hover', 'drop-before', 'drop-after'));
}

/* ---------- 目录树文件夹拖拽辅助 ---------- */

// 递归收集文件夹节点下所有后代 id（文件夹 + 书签），作为拖动该文件夹时的放置禁区
function collectDescendants(folderNode) {
  const out = new Set();
  const walk = (nodes) => {
    for (const c of nodes) {
      out.add(c.id);
      if (c.children) walk(c.children);
    }
  };
  walk(folderNode.children || []);
  return out;
}

// 拖动文件夹时，目标位于其自身或子树内则禁止放置（防止把目录移进自己/后代造成循环）
function dragCoversTarget(targetId) {
  return !!dragState.isFolder &&
    (dragState.card.id === targetId || (dragState.descendantIds || new Set()).has(targetId));
}

function currentSidebarWidth() {
  return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w')) || 240;
}

function applySidebarWidth() {
  const w = Math.round(Number(settings.sidebarWidth)) || 240;
  document.documentElement.style.setProperty('--sidebar-w', w + 'px');
}

/* 拖拽把手：按住右缘把手拖动实时调整侧栏宽度（200–480px），松手持久化；
 * 主区 flex 自适应，搜索栏宽度随网格实时重校准；宽度属个人偏好，不参与 WebDAV 同步 */
function bindSidebarResizer() {
  const resizer = $('#sidebarResizer');
  let resizing = null;
  resizer.addEventListener('pointerdown', (e) => {
    if (document.body.classList.contains('collapsed')) return; // 折叠状态不可拖
    e.preventDefault();
    resizing = { x: e.clientX, w: currentSidebarWidth() };
    resizer.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
  });
  resizer.addEventListener('pointermove', (e) => {
    if (!resizing) return;
    const w = Math.min(480, Math.max(200, Math.round(resizing.w + e.clientX - resizing.x)));
    settings.sidebarWidth = w;
    applySidebarWidth();
    alignStickyTop();
  });
  resizer.addEventListener('pointerup', async (e) => {
    if (!resizing) return;
    resizing = null;
    resizer.releasePointerCapture(e.pointerId);
    document.body.classList.remove('resizing');
    await saveSettings();
  });
  resizer.addEventListener('pointercancel', () => {
    resizing = null;
    document.body.classList.remove('resizing');
  });
}

document.addEventListener('DOMContentLoaded', init);

async function init() {
  await ensureFolders();
  await loadAll();
  applySidebarWidth();
  bindUI();
  renderAll();
  applyGlass();
  watchBookmarks();
  // 订阅了必应每日壁纸且缓存过期时，后台刷新今天的新图
  if (settings.bg === 'bing') refreshBingBg();
}

/* ---------- 浏览器书签实时监听 ----------
 * 任何层级、任何来源的书签变化（书签管理器增删改、其他设备 Chrome 同步、
 * 网页右键「收藏到卡片墙」等）都会合并去抖后立刻刷新卡片墙；
 * 插件内的操作本身直接写 chrome.bookmarks，天然双向一致。
 */
let reloadTimer = null;
let reloadPendingWhileDragging = false;

function watchBookmarks() {
  for (const ev of ['onCreated', 'onRemoved', 'onMoved', 'onChanged', 'onChildrenReordered']) {
    chrome.bookmarks[ev].addListener(scheduleReload);
  }
}

function scheduleReload() {
  // 拖拽进行中不重渲染（会拆掉被拖拽的 DOM），记起来拖拽结束后再刷
  if (dragState) {
    reloadPendingWhileDragging = true;
    return;
  }
  if (reloadTimer) return; // 去抖：批量导入等操作会触发一连串事件
  reloadTimer = setTimeout(flushReload, 150);
}

async function flushReload() {
  reloadTimer = null;
  if (dragState) {
    reloadPendingWhileDragging = true;
    return;
  }
  const savedPages = { ...groupPages };
  await loadAll();
  renderAll();
  groupPages = savedPages; // 外部变化不打断用户正在看的分页位置
  renderGrid();
}

function afterDragFlush() {
  if (reloadPendingWhileDragging) {
    reloadPendingWhileDragging = false;
    flushReload();
  }
}

/* ---------- 数据加载 ---------- */

async function bookmarkExists(id) {
  try {
    await chrome.bookmarks.get(id);
    return true;
  } catch {
    return false;
  }
}

/* 同名根目录去重自愈：
 * 历史原因可能在书签栏产生多个「📌 卡片墙」文件夹（首次安装时后台与新标签页并发创建、
 * 手动复制过、或 meta 里记录的 id 失效后又新建）。启动时统一收敛：
 * meta 记录且仍存在的优先，否则保留书签数量最多的；其余目录的子节点
 * （同名子文件夹递归融合，避免合并出重名分组）并入保留目录后删除空壳。
 * 返回收敛后的唯一目录 id；不存在则返回 null（由调用方创建）。 */
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

/* 把 srcId 整棵目录合并进 dstId：同名子文件夹递归融合，其余按原顺序追加到末尾 */
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
  const bar = tree[0].children[0];   // 书签栏
  const other = tree[0].children[1]; // 其他书签

  wallFolderId = await dedupeRootFolders(bar.id, '📌 卡片墙', meta.wallFolderId);
  trashFolderId = await dedupeRootFolders(other.id, '🗑 卡片墙回收站', meta.trashFolderId);

  if (!wallFolderId) {
    wallFolderId = (await chrome.bookmarks.create({ parentId: bar.id, title: '📌 卡片墙' })).id;
  }
  if (!trashFolderId) {
    trashFolderId = (await chrome.bookmarks.create({ parentId: other.id, title: '🗑 卡片墙回收站' })).id;
  }
  await chrome.storage.local.set({ meta: { wallFolderId, trashFolderId } });
}

function flatten(nodes, out = []) {
  for (const n of nodes) {
    if (n.url) out.push({ id: n.id, title: n.title || n.url, url: n.url });
    else if (n.children) flatten(n.children, out);
  }
  return out;
}

async function loadAll() {
  const st = await chrome.storage.local.get({ cardTags: {}, settings: {}, syncConfig: null });
  cardTags = st.cardTags;
  settings = {
    sidebarCollapsed: false, bg: 'grad:aurora', layoutN: 4, sidebarWidth: 240,
    glassOpacity: 0.13, bingCache: null, collapsedGroups: [], treeExpanded: [],
    ...st.settings,
  };
  encConfig = st.syncConfig;
  // 迁移：清除旧版本明文保存的 WebDAV 配置
  if (st.settings.webdav) {
    delete st.settings.webdav;
    await chrome.storage.local.set({ settings: st.settings });
  }
  const [wall, trash] = await Promise.all([
    chrome.bookmarks.getSubTree(wallFolderId),
    chrome.bookmarks.getSubTree(trashFolderId),
  ]);

  // 按书签大类分组：子文件夹 = 一个组；根下直接放的书签归入「未分类」
  groups = [];
  const rootItems = [];
  for (const n of wall[0].children) {
    if (n.url) rootItems.push({ id: n.id, title: n.title || n.url, url: n.url });
    else groups.push({ id: n.id, title: n.title || '未命名分组', items: flatten(n.children) });
  }
  if (rootItems.length) {
    groups.unshift({ id: ROOT_GROUP_ID, title: '未分类', items: rootItems });
  }
  // 侧边栏目录树：保留完整嵌套结构
  wallTreeData = buildTreeNodes(wall[0].children);
  trashCards = flatten(trash[0].children);

  // 树节点聚焦视图：数据变化后刷新聚焦分组的内容
  if (view.group) {
    try {
      const sub = await chrome.bookmarks.getSubTree(view.group);
      focusGroup = { id: view.group, title: sub[0].title || '未命名', items: flatten(sub[0].children) };
    } catch {
      view.group = null; // 文件夹已被删除，回到全部视图
      focusGroup = null;
    }
  } else {
    focusGroup = null;
  }
}

function buildTreeNodes(nodes) {
  const out = [];
  for (const n of nodes) {
    if (n.url) {
      out.push({ type: 'link', id: n.id, title: n.title || n.url, url: n.url });
    } else {
      out.push({ type: 'folder', id: n.id, title: n.title || '未命名', children: buildTreeNodes(n.children || []) });
    }
  }
  return out;
}

function countTreeLinks(node) {
  if (node.type === 'link') return 1;
  return node.children.reduce((s, c) => s + countTreeLinks(c), 0);
}

function saveTags() {
  return chrome.storage.local.set({ cardTags });
}
function saveSettings() {
  return chrome.storage.local.set({ settings });
}

function allCards() {
  return groups.flatMap((g) => g.items);
}

function groupTitleOf(url) {
  const g = groups.find((g) => g.items.some((c) => c.url === url));
  return g ? g.title : '';
}

/* ---------- 工具函数 ---------- */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function faviconUrl(url) {
  return chrome.runtime.getURL('_favicon/') + '?pageUrl=' + encodeURIComponent(url) + '&size=64';
}

function letterIcon(url) {
  const ch = (hostOf(url)[0] || '?').toUpperCase();
  let hue = 0;
  for (const c of hostOf(url)) hue = (hue * 31 + c.charCodeAt(0)) % 360;
  return { ch, color: `hsl(${hue}, 55%, 45%)` };
}

function tagsOf(url) {
  return cardTags[url]?.tags || [];
}

/* ---------- 过滤 ---------- */

function matchCard(c) {
  if (view.tag && !tagsOf(c.url).includes(view.tag)) return false;
  if (view.q) {
    const q = view.q.toLowerCase();
    return (
      c.title.toLowerCase().includes(q) ||
      c.url.toLowerCase().includes(q) ||
      tagsOf(c.url).some((t) => t.toLowerCase().includes(q))
    );
  }
  return true;
}

function filteredGroups() {
  let gs = groups;
  if (view.group) {
    // 树聚焦的可以是任意层级文件夹（focusGroup），也可以是顶层分组（groups）
    const g = (focusGroup && focusGroup.id === view.group ? focusGroup : null)
      || groups.find((x) => x.id === view.group);
    if (!g) return [];
    gs = [g];
  }
  return gs
    .map((g) => ({ ...g, items: g.items.filter(matchCard) }))
    .filter((g) => g.items.length);
}

/* ---------- 渲染 ---------- */

function renderAll() {
  groupPages = {}; // 数据或过滤条件变化时，各分组回到第 1 页
  renderSidebar();
  renderHeader();
  renderGrid();
  applyBg();
}

function layoutN() {
  const n = parseInt(settings.layoutN, 10);
  return Number.isInteger(n) && n >= 2 && n <= 8 ? n : 4;
}

/* 悬浮搜索栏宽度 = 卡片网格实际占用的宽度（列数 × 卡宽 + 间隙），
   左右边界与卡片严丝合缝；卡片固定尺寸，列数 = min(设置的 N, 容器可容纳列数)，
   由这里统一计算并写入 --grid-cols 供 .group-grid 使用（实测后生效） */
function alignStickyTop() {
  const bar = $('#stickyTop');
  if (!bar) return;
  const probe = view.mode === 'trash' ? $('#grid') : document.querySelector('.group-grid');
  if (!probe) {
    bar.style.width = '';
    return;
  }
  const cardW = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--card-w')) || 170;
  const gap = 14;
  const fitCols = Math.max(1, Math.floor((probe.clientWidth + gap) / (cardW + gap)));
  const cols = Math.min(layoutN(), fitCols); // 方阵上限 N；容器不够时自动降列
  document.documentElement.style.setProperty('--grid-cols', cols);
  bar.style.width = cols * cardW + (cols - 1) * gap + 'px';
}

function renderGrid() {
  const grid = $('#grid');
  grid.textContent = '';
  const empty = $('#emptyHint');
  const isTrash = view.mode === 'trash';
  grid.classList.toggle('flat', isTrash);

  let count = 0;
  const frag = document.createDocumentFragment();

  if (isTrash) {
    for (const c of trashCards) {
      if (matchTrashCard(c)) {
        frag.appendChild(makeCardEl(c, { isTrash: true, size: 'mini' }));
        count++;
      }
    }
  } else {
    const N = layoutN();
    const perPage = N * N;
    // 单分组聚焦视图：页面标题栏已标明目录，区块不再重复渲染组头
    const single = !!view.group;
    for (const g of filteredGroups()) {
      const collapsed = !single && (settings.collapsedGroups || []).includes(g.id);
      const totalPages = Math.max(1, Math.ceil(g.items.length / perPage));
      const page = Math.min(groupPages[g.id] || 0, totalPages - 1);

      const sec = document.createElement('section');
      sec.className = 'group-sec';

      // 组头：点击折叠/展开（聚焦视图下省略，避免与页面标题重复）
      if (!single) {
        const head = document.createElement('div');
        head.className = 'group-head';
        head.innerHTML = `<span class="chev">${collapsed ? '▸' : '▾'}</span>
          <span class="g-icon">📁</span>
          <span class="g-title">${escapeHtml(g.title)}</span>
          <span class="g-count">${g.items.length} 张${totalPages > 1 && !collapsed ? ` · 第 ${page + 1}/${totalPages} 页` : ''}</span>`;
        head.addEventListener('click', () => toggleGroupCollapse(g.id));
        sec.appendChild(head);
      }

      if (!collapsed) {
        if (totalPages > 1) {
          /* 三槽滑动轨道：[上一页 | 当前页 | 下一页]，跟手平移 + 阈值翻页/硬币回弹 */
          const pager = document.createElement('div');
          pager.className = 'pager';
          const track = document.createElement('div');
          track.className = 'track';
          const mkPage = (items) => {
            const pg = document.createElement('div');
            pg.className = 'page';
            const grid = document.createElement('div');
            grid.className = 'group-grid';
            for (const c of items) {
              grid.appendChild(makeCardEl(c, { groupTitle: g.title, size: 'card' }));
            }
            pg.appendChild(grid);
            return pg;
          };
          track.append(
            mkPage(page > 0 ? g.items.slice((page - 1) * perPage, page * perPage) : []),
            mkPage(g.items.slice(page * perPage, (page + 1) * perPage)),
            mkPage(page < totalPages - 1 ? g.items.slice((page + 1) * perPage, (page + 2) * perPage) : [])
          );
          pager.appendChild(track);
          sec.appendChild(pager);
          attachPagerGestures(pager, track, g.id, page, totalPages, perPage);
        } else {
          // 单页：普通网格
          const box = document.createElement('div');
          box.className = 'group-grid';
          for (const c of g.items.slice(page * perPage, (page + 1) * perPage)) {
            box.appendChild(makeCardEl(c, { groupTitle: g.title, size: 'card' }));
          }
          sec.appendChild(box);
        }

        // 分页圆点：透明圆圈，当前页实心填充
        if (totalPages > 1) {
          const dots = document.createElement('div');
          dots.className = 'dots';
          for (let i = 0; i < totalPages; i++) {
            const d = document.createElement('span');
            d.className = 'dot' + (i === page ? ' active' : '');
            d.title = `${g.title} · 第 ${i + 1} 页`;
            d.addEventListener('click', () => {
              groupPages[g.id] = i;
              renderGrid();
            });
            dots.appendChild(d);
          }
          sec.appendChild(dots);
        }
      }
      frag.appendChild(sec);
      attachSwipe(sec, g.id, totalPages);
      count += g.items.length;
    }
  }

  if (!count) {
    $('#emptyText').textContent =
      view.q ? '🔍 没有匹配的收藏'
        : isTrash ? '🗑 回收站是空的'
          : '🌟 还没有收藏卡片';
    empty.classList.remove('hidden');
    empty.querySelector('.muted').textContent =
      isTrash
        ? '删除的卡片会先放在这里，可恢复或彻底删除'
        : '点击左侧「⇓ 导入书签」一键导入现有书签，或在任意网页右键选择「收藏到卡片墙」';
  } else {
    empty.classList.add('hidden');
  }
  grid.appendChild(frag);
  requestAnimationFrame(alignStickyTop);
}

// 折叠状态持久化到 settings；只重渲染网格，不重置分页
async function toggleGroupCollapse(gid) {
  const set = new Set(settings.collapsedGroups || []);
  if (set.has(gid)) set.delete(gid);
  else set.add(gid);
  settings.collapsedGroups = [...set];
  await saveSettings();
  renderGrid();
}

/* 组内滑动切页：触控板横向滚动（往左滑 = 下一页），带节流防连翻 */
function attachSwipe(sec, gid, totalPages) {
  if (totalPages <= 1) return;
  const go = (delta) => {
    const cur = groupPages[gid] || 0;
    const next = Math.min(totalPages - 1, Math.max(0, cur + delta));
    if (next !== cur) {
      groupPages[gid] = next;
      renderGrid();
    }
  };

  let lastSwitch = 0;
  sec.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) || Math.abs(e.deltaX) < 10) return;
    e.preventDefault();
    const now = Date.now();
    if (now - lastSwitch < 350) return;
    lastSwitch = now;
    go(e.deltaX > 0 ? 1 : -1);
  }, { passive: false });
}

/* 触摸跟手翻页：
 * - 拖动时轨道实时平移（第一页右拉/最后一页左拉有橡皮筋阻力）
 * - 松手时位移超过半页 → 动画翻到目标页；否则硬币式衰减摆动后复位
 * - 纵向滑动让位给页面滚动（touch-action: pan-y + 位移方向判定）
 */
function attachPagerGestures(pager, track, gid, page, totalPages, perPage) {
  const IDLE = 'translateX(-33.3333%)';
  let start = null;
  let dx = 0;

  pager.addEventListener('touchstart', (e) => {
    start = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    dx = 0;
    track.style.transition = 'none';
    track.classList.remove('wobble');
  }, { passive: true });

  pager.addEventListener('touchmove', (e) => {
    if (!start) return;
    const dy = e.touches[0].clientY - start.y;
    const ndx = e.touches[0].clientX - start.x;
    // 明显纵向滑动：放弃本次翻页手势，让页面正常滚动
    if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(ndx)) {
      start = null;
      track.style.transform = IDLE;
      return;
    }
    dx = ndx;
    let eff = dx;
    // 边界阻力（橡皮筋）：第一页右拉 / 最后一页左拉
    if ((page === 0 && dx > 0) || (page === totalPages - 1 && dx < 0)) eff = dx * 0.25;
    track.style.transform = `translateX(calc(-33.3333% + ${eff}px))`;
  }, { passive: true });

  pager.addEventListener('touchend', () => {
    if (!start) return;
    start = null;
    const width = pager.clientWidth;
    const atEdge = (page === 0 && dx > 0) || (page === totalPages - 1 && dx < 0);

    if (!atEdge && Math.abs(dx) > width / 2) {
      // 超过半页：动画滑到目标页，动画结束再重渲染为新的静止态
      const newPage = dx < 0 ? page + 1 : page - 1;
      const target = dx < 0 ? '-66.6667%' : '0%';
      track.style.transition = 'transform 0.35s cubic-bezier(0.22, 0.9, 0.36, 1)';
      track.style.transform = `translateX(${target})`;
      track.addEventListener('transitionend', () => {
        groupPages[gid] = newPage;
        renderGrid();
      }, { once: true });
    } else {
      wobbleBack(track, dx);
    }
  });

  pager.addEventListener('touchcancel', () => {
    start = null;
    wobbleBack(track, dx);
  });
}

// 硬币式复位：从当前偏移出发，左右衰减摆动后静止（振幅 ×0.38 递减）
function wobbleBack(track, dx) {
  track.style.transition = 'none';
  if (Math.abs(dx) < 4) {
    track.style.transform = '';
    return;
  }
  const k = 0.38;
  const set = (n, v) => track.style.setProperty(`--w${n}`, `${v}px`);
  set(0, dx);
  set(1, -dx * k);
  set(2, dx * k * k);
  set(3, -dx * k * k * k);
  track.classList.add('wobble');
  track.addEventListener('animationend', () => {
    track.classList.remove('wobble');
    track.style.transform = ''; // 回到 CSS 默认的静止位
  }, { once: true });
}

function renderSidebar() {
  // 分组区：目录树（文件夹逐级展开，书签点击打开）
  const treeBox = $('#groupList');
  treeBox.textContent = '';
  if (!wallTreeData.length) {
    const tip = document.createElement('div');
    tip.className = 'muted';
    tip.style.cssText = 'font-size:12px;padding:4px 12px;';
    tip.textContent = '暂无分组';
    treeBox.appendChild(tip);
  }
  renderTreeNodes(wallTreeData, 0, treeBox);
  renderTagBar();

  $('#trashCount').textContent = trashCards.length ? `(${trashCards.length})` : '';
  $('#trashBtn').classList.toggle('active', view.mode === 'trash');
}

/* ---------- 标签条：单行 "tag×数" 文本，放不下时右侧按钮展开全部 ---------- */
let tagsExpanded = false;

function renderTagBar() {
  const box = $('#tagBar');
  box.textContent = '';
  const m = new Map();
  for (const c of allCards()) for (const t of tagsOf(c.url)) m.set(t, (m.get(t) || 0) + 1);
  const tags = [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  if (!tags.length) {
    const tip = document.createElement('span');
    tip.className = 'muted';
    tip.style.fontSize = '12px';
    tip.textContent = '暂无标签';
    box.appendChild(tip);
  }
  for (const [t, n] of tags) {
    const chip = document.createElement('span');
    chip.className = 'tchip' + (view.tag === t ? ' active' : '');
    chip.dataset.tag = t;
    chip.textContent = `${t}×${n}`;
    box.appendChild(chip);
  }

  // 内容超出一行时显示展开按钮；展开状态下按钮常驻（用于收起）
  requestAnimationFrame(() => {
    const over = box.scrollWidth > box.clientWidth + 2;
    const btn = $('#tagToggle');
    btn.classList.toggle('hidden', !(over || tagsExpanded));
    btn.textContent = tagsExpanded ? '▴' : '▾';
    $('#tagBarWrap').classList.toggle('expanded', tagsExpanded);
  });
}

// 递归渲染目录树；展开状态持久化在 settings.treeExpanded
function renderTreeNodes(nodes, depth, container) {
  for (const n of nodes) {
    const row = document.createElement('div');
    row.className = 'tree-row';
    row.dataset.id = n.id;
    row.style.paddingLeft = 8 + depth * 14 + 'px';

    if (n.type === 'folder') {
      const open = (settings.treeExpanded || []).includes(n.id);
      row.innerHTML = `<span class="chev">${open ? '▾' : '▸'}</span><span class="t-icon">📁</span>
        <span class="t-title">${escapeHtml(n.title)}</span>
        <span class="tree-count">${countTreeLinks(n)}</span>`;
      // 点击整行 = 切换展开/收起（展开时右侧聚焦该目录，收起时若正聚焦则返回全部）
      row.addEventListener('click', () => toggleTreeFolder(n));

      // 拖放目标：松手把书签/目录移入该目录；悬停折叠目录自动展开，可继续往深层拖
      row.addEventListener('dragover', (e) => {
        if (!dragState || dragState.isTrash || dragState.card.id === n.id) return;
        if (dragCoversTarget(n.id)) return; // 拖动目录不可放入自身或其子目录
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        row.classList.add('drop-hover');
        scheduleTreeExpand(n);
      });
      row.addEventListener('dragleave', (e) => {
        if (e.relatedTarget && row.contains(e.relatedTarget)) return; // 行内子元素间移动不算离开
        row.classList.remove('drop-hover');
        cancelTreeExpand();
      });
      row.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        row.classList.remove('drop-hover');
        cancelTreeExpand();
        if (!dragState || dragState.isTrash || dragCoversTarget(n.id)) return;
        await moveToFolder(dragState.card, n.id);
      });

      // 目录本身可拖动：拖到其他目录上 = 整体移入（含全部内容），拖到回收站 = 目录内收藏全部移入回收站
      row.draggable = true;
      row.addEventListener('dragstart', (e) => {
        dragState = {
          card: { id: n.id, title: n.title, url: null },
          isTrash: false,
          isFolder: true,
          descendantIds: collectDescendants(n), // 子树内所有节点 id（放置禁区）
        };
        row.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', n.id);
      });
      row.addEventListener('dragend', () => {
        dragState = null;
        row.classList.remove('dragging');
        clearTreeDropHovers();
        cancelTreeExpand();
        afterDragFlush();
      });

      container.appendChild(row);
      if (open) renderTreeNodes(n.children, depth + 1, container);
    } else {
      row.classList.add('tree-link');
      row.title = n.title + '\n' + n.url;
      row.innerHTML = `<span class="chev"></span>
        <span class="t-ico"></span>
        <span class="t-title">${escapeHtml(n.title)}</span>`;
      row.addEventListener('click', () => window.open(n.url, '_blank'));
      const holder = row.querySelector('.t-ico');
      const img = document.createElement('img');
      img.src = faviconUrl(n.url);
      img.onerror = () => holder.textContent = '🔗';
      holder.appendChild(img);
      container.appendChild(row);

      // 树内链接可拖动：拖到另一链接上 = 排序（真实书签顺序同步变化）
      row.draggable = true;
      row.addEventListener('dragstart', (e) => {
        dragState = { card: { id: n.id, title: n.title, url: n.url }, isTrash: false };
        row.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', n.id);
      });
      row.addEventListener('dragend', () => {
        dragState = null;
        row.classList.remove('dragging');
        clearTreeDropHovers();
        cancelTreeExpand();
        afterDragFlush();
      });
      // 树是纵向列表：光标在上半 = 插到它前面，下半 = 插到它后面
      row.addEventListener('dragover', (e) => {
        if (!dragState || dragState.isTrash || dragState.card.id === n.id) return;
        if (dragCoversTarget(n.id)) return; // 拖动目录不可放到其子树内的链接旁
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const rect = row.getBoundingClientRect();
        const before = e.clientY - rect.top < rect.height / 2;
        row.classList.toggle('drop-before', before);
        row.classList.toggle('drop-after', !before);
      });
      row.addEventListener('dragleave', (e) => {
        if (e.relatedTarget && row.contains(e.relatedTarget)) return;
        row.classList.remove('drop-before', 'drop-after');
      });
      row.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const before = row.classList.contains('drop-before');
        row.classList.remove('drop-before', 'drop-after');
        if (!dragState || dragState.isTrash || dragState.card.id === n.id) return;
        if (dragCoversTarget(n.id)) return;
        await moveBookmark(dragState.card, n, before ? 'before' : 'after');
      });
    }
  }
}

/* 点击树目录行 = 切换展开/收起：
 * - 关闭状态 → 展开，同时右侧聚焦该目录
 * - 展开状态 → 收起；若右侧正聚焦它，同时返回全部视图
 * 重渲染后恢复侧边栏滚动位置：展开/收起只影响该行下方内容，
 * 因此点击行在鼠标下保持原位不跳动
 */
async function toggleTreeFolder(node) {
  const container = $('#groupList');
  const savedScroll = container.scrollTop;
  const isOpen = (settings.treeExpanded || []).includes(node.id);

  if (isOpen) {
    settings.treeExpanded = (settings.treeExpanded || []).filter((id) => id !== node.id);
    if (view.group === node.id) {
      view.group = null;
      focusGroup = null;
      view.tag = null;
      await saveSettings();
      renderAll();
    } else {
      await saveSettings();
      renderSidebar();
    }
  } else {
    try {
      const sub = await chrome.bookmarks.getSubTree(node.id);
      focusGroup = { id: node.id, title: sub[0].title || '未命名', items: flatten(sub[0].children) };
    } catch {
      return; // 文件夹已被删除
    }
    settings.treeExpanded = [...(settings.treeExpanded || []), node.id];
    view.group = node.id;
    view.tag = null;
    view.mode = 'wall';
    await saveSettings();
    renderAll();
  }

  container.scrollTop = savedScroll; // 保持点击行位置不动
}

function renderHeader() {
  // 悬浮栏仅承载「清空回收站」按钮
  $('#emptyTrashBtn').classList.toggle('hidden', !(view.mode === 'trash' && trashCards.length > 0));

  // 视图徽标显示在侧边栏品牌下方；默认视图（全部收藏、无搜索）时隐藏
  const badge = $('#viewBadge');
  let label = null;
  let n = 0;
  if (view.mode === 'trash') {
    label = '🗑 回收站';
    n = trashCards.length;
  } else if (view.tag) {
    label = `# ${view.tag}`;
    n = filteredGroups().reduce((s, g) => s + g.items.length, 0);
  } else if (view.group) {
    const g = (focusGroup && focusGroup.id === view.group ? focusGroup : null)
      || groups.find((x) => x.id === view.group);
    label = '📁 ' + (g?.title || '');
    n = filteredGroups().reduce((s, g) => s + g.items.length, 0);
  } else if (view.q) {
    label = `🔍 ${view.q}`;
    n = filteredGroups().reduce((s, g) => s + g.items.length, 0);
  }

  if (label) {
    badge.textContent = `${label} · ${n}`;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

function matchTrashCard(c) {
  if (!view.q) return true;
  const q = view.q.toLowerCase();
  return (
    c.title.toLowerCase().includes(q) ||
    c.url.toLowerCase().includes(q) ||
    tagsOf(c.url).some((t) => t.toLowerCase().includes(q))
  );
}

function makeCardEl(c, { groupTitle = '', isTrash = false, size = 'card' } = {}) {
  const el = document.createElement('div');
  el.className = size;

  const icon = letterIcon(c.url);
  el.innerHTML = `
    <a class="card-link" href="${escapeHtml(c.url)}" target="_blank" rel="noreferrer">
      <div class="card-top">
        <div class="card-icon" style="background:${icon.color}"></div>
        <div class="card-url">${escapeHtml(hostOf(c.url))}</div>
      </div>
      <div class="card-title">${escapeHtml(c.title)}</div>
    </a>
    <div class="card-tags"></div>
    <div class="card-tools">
      ${isTrash ? `
        <button class="icon-btn" data-act="restore" title="恢复到卡片墙">♻</button>
        <button class="icon-btn del" data-act="purge" title="彻底删除">🗑</button>` : `
        <button class="icon-btn" data-act="edit" title="编辑标签">✎</button>
        <button class="icon-btn del" data-act="trash" title="移入回收站">×</button>`}
    </div>`;

  // favicon：加载失败则回退到首字母
  const iconEl = el.querySelector('.card-icon');
  const img = document.createElement('img');
  img.src = faviconUrl(c.url);
  img.onerror = () => img.remove();
  iconEl.appendChild(img);

  // 归属文件夹标签 + tag 标签
  const tagBox = el.querySelector('.card-tags');
  if (!isTrash && groupTitle) {
    tagBox.appendChild(makeChip('📁 ' + groupTitle, 'folder-chip', () => {
      view.group = groupTitle === '未分类' ? ROOT_GROUP_ID
        : groups.find((g) => g.title === groupTitle)?.id || null;
      view.tag = null;
      view.mode = 'wall';
      renderAll();
    }));
  }
  if (isTrash) {
    const d = cardTags[c.url]?.deletedAt;
    if (d) {
      const note = document.createElement('span');
      note.className = 'muted';
      note.style.fontSize = '11px';
      note.textContent = '删除于 ' + new Date(d).toLocaleDateString();
      tagBox.appendChild(note);
    }
  }
  if (!isTrash) {
    for (const t of tagsOf(c.url)) {
      tagBox.appendChild(makeChip('# ' + t, '', () => {
        view.tag = t;
        view.mode = 'wall';
        renderAll();
      }));
    }
  }

  for (const btn of el.querySelectorAll('.icon-btn')) {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const act = btn.dataset.act;
      if (act === 'trash') await trashCard(c);
      else if (act === 'edit') openEditDlg(c.url);
      else if (act === 'restore') await restoreCard(c);
      else if (act === 'purge') await purgeCard(c);
    });
  }

  // 拖拽：墙内卡片可排序/跨组移动；拖到侧边栏回收站 = 移入回收站
  if (!isTrash) {
    const link = el.querySelector('.card-link');
    link.draggable = false; // 防止链接默认拖拽劫持
    el.draggable = true;
    el.addEventListener('dragstart', (e) => {
      dragState = { card: c, isTrash };
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', c.id);
    });
    el.addEventListener('dragend', () => {
      dragState = null;
      el.classList.remove('dragging', 'drop-before', 'drop-after');
      clearTreeDropHovers();
      cancelTreeExpand();
      afterDragFlush();
    });
    el.addEventListener('dragover', (e) => {
      if (!dragState || dragState.isTrash || dragState.card.id === c.id) return;
      if (dragCoversTarget(c.id)) return; // 拖动目录不可放到其子树内的卡片上
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = el.getBoundingClientRect();
      const before = e.clientX - rect.left < rect.width / 2;
      el.classList.toggle('drop-before', before);
      el.classList.toggle('drop-after', !before);
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-before', 'drop-after'));
    el.addEventListener('drop', async (e) => {
      e.preventDefault();
      const before = el.classList.contains('drop-before');
      el.classList.remove('drop-before', 'drop-after');
      if (!dragState || dragState.isTrash || dragState.card.id === c.id) return;
      if (dragCoversTarget(c.id)) return;
      await moveBookmark(dragState.card, c, before ? 'before' : 'after');
    });
  }
  return el;
}

/* 拖拽排序/跨组移动：position = 'before' | 'after'（相对目标卡片） */
async function moveBookmark(dragCard, targetCard, position) {
  const [dragInfo] = await chrome.bookmarks.get(dragCard.id);
  const [targetInfo] = await chrome.bookmarks.get(targetCard.id);
  const parentId = targetInfo.parentId;
  const children = await chrome.bookmarks.getChildren(parentId);
  const tIdx = children.findIndex((x) => x.id === targetCard.id);
  if (tIdx < 0) return;

  let index;
  if (dragInfo.parentId === parentId) {
    const cIdx = children.findIndex((x) => x.id === dragCard.id);
    if (cIdx < 0) return;
    // Chrome 的 move 先移除再按目标索引插入，同父移动需修正偏移
    if (position === 'before') {
      index = cIdx < tIdx ? tIdx - 1 : tIdx;
      if (index === cIdx) return; // 位置没变
    } else {
      index = cIdx < tIdx ? tIdx : tIdx + 1;
      if (index === cIdx + 1) return; // 位置没变
    }
  } else {
    index = position === 'before' ? tIdx : tIdx + 1;
  }
  try {
    await chrome.bookmarks.move(dragCard.id, { parentId, index });
  } catch {
    return; // Chrome 拒绝移动（如把文件夹移入其后代），保持原状
  }
  await loadAll();
  renderAll();
}

function makeChip(label, extraCls, onClick) {
  const chip = document.createElement('span');
  chip.className = 'chip' + (extraCls ? ' ' + extraCls : '');
  chip.textContent = label;
  chip.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  return chip;
}

/* ---------- 卡片操作 ---------- */

async function trashCard(c) {
  cardTags[c.url] = { ...(cardTags[c.url] || { tags: [] }), deletedAt: Date.now() };
  await saveTags();
  await chrome.bookmarks.move(c.id, { parentId: trashFolderId });
  await loadAll();
  renderAll();
}

/* 目录整体移入回收站：目录下全部收藏（含嵌套子目录）逐个移入回收站文件夹，
 * 每个链接标记 deletedAt 以便回收站显示删除日期；最后删除空目录结构。
 * 拖目录到「回收站」按钮即调用本函数（目录本身消失，收藏可在回收站逐张恢复） */
async function trashFolder(st) {
  const folderId = st.card.id;
  const gone = new Set([folderId, ...st.descendantIds]); // 目录本身 + 子树全部节点
  try {
    const [sub] = await chrome.bookmarks.getSubTree(folderId);
    const links = flatten(sub.children); // 递归收集目录内全部书签（含嵌套）
    const now = Date.now();
    for (const c of links) {
      cardTags[c.url] = { ...(cardTags[c.url] || { tags: [] }), deletedAt: now };
    }
    await saveTags();
    for (const c of links) {
      try { await chrome.bookmarks.move(c.id, { parentId: trashFolderId }); }
      catch (err) { console.warn('[card-wall] 移入回收站失败：', c.url, err); }
    }
    try { await chrome.bookmarks.removeTree(folderId); } catch (err) { console.warn('[card-wall] 删除目录结构失败：', err); }
  } catch (err) {
    console.warn('[card-wall] trashFolder 失败：', err);
    return;
  }
  // 正聚焦被删目录（或其子目录）时回到「全部」视图；清理持久化状态里的残留 id
  if (view.group && gone.has(view.group)) {
    view.group = null;
    focusGroup = null;
  }
  settings.treeExpanded = (settings.treeExpanded || []).filter((id) => !gone.has(id));
  settings.collapsedGroups = (settings.collapsedGroups || []).filter((id) => !gone.has(id));
  await saveSettings();
  await loadAll();
  renderAll();
}

async function restoreCard(c) {
  await chrome.bookmarks.move(c.id, { parentId: wallFolderId });
  if (cardTags[c.url]) {
    delete cardTags[c.url].deletedAt;
    await saveTags();
  }
  await loadAll();
  renderAll();
}

async function purgeCard(c) {
  // bookmarks.remove 会触发 background 的 onRemoved 自动清理 tag
  await chrome.bookmarks.remove(c.id);
  await loadAll();
  renderAll();
}

async function emptyTrash() {
  const sub = await chrome.bookmarks.getSubTree(trashFolderId);
  for (const n of sub[0].children) {
    if (n.url) await chrome.bookmarks.remove(n.id);
    else await chrome.bookmarks.removeTree(n.id);
  }
  await loadAll();
  renderAll();
}

/* ---------- 一键导入书签 ---------- *
 *
 * 把「书签栏」和「其他书签」里的书签复制到卡片墙，保留文件夹层级（文件夹=分组）。
 * 复制而非移动：原书签保持不动；URL 已存在于卡片墙的自动跳过。
 */

function indexFolders(nodes, prefix, idx) {
  for (const n of nodes) {
    if (n.url) continue;
    const p = prefix + '/' + n.title;
    idx.set(p, n);
    indexFolders(n.children, p, idx);
  }
}

async function importBookmarks() {
  const [tree, wallTree] = await Promise.all([
    chrome.bookmarks.getTree(),
    chrome.bookmarks.getSubTree(wallFolderId),
  ]);
  const existing = new Set(flatten(wallTree[0].children).map((c) => c.url));
  const folderIndex = new Map(); // 路径 -> 已存在的同名文件夹（重复导入时复用）
  indexFolders(wallTree[0].children, '', folderIndex);

  let added = 0, skipped = 0;

  async function walk(node, parentPath, targetParentId) {
    if (node.id === wallFolderId || node.id === trashFolderId) return; // 跳过卡片墙自身和回收站
    if (node.url) {
      if (existing.has(node.url)) {
        skipped++;
        return;
      }
      await chrome.bookmarks.create({ parentId: targetParentId, title: node.title || node.url, url: node.url });
      existing.add(node.url);
      added++;
      return;
    }
    const children = (node.children || []).filter(
      (c) => c.id !== wallFolderId && c.id !== trashFolderId
    );
    const path = parentPath + '/' + node.title;
    let targetId = folderIndex.get(path)?.id;
    if (!targetId && children.length) {
      targetId = (await chrome.bookmarks.create({ parentId: targetParentId, title: node.title })).id;
      folderIndex.set(path, { id: targetId });
    }
    for (const c of children) await walk(c, path, targetId);
  }

  for (const top of tree[0].children) {
    // 顶层根（书签栏/其他书签）本身不作为分组，直接处理其子节点
    for (const c of top.children || []) {
      await walk(c, '', wallFolderId);
    }
  }
  return { added, skipped };
}

async function runImport() {
  if (!confirm(
    '将「书签栏」和「其他书签」中的收藏复制到卡片墙：\n' +
    '· 保留文件夹层级，文件夹自动变成分组\n' +
    '· 重复链接自动跳过\n' +
    '· 原书签保持不动\n\n继续导入？'
  )) return;
  const btn = $('#importBtn');
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = '导入中…';
  try {
    const { added, skipped } = await importBookmarks();
    await loadAll();
    renderAll();
    alert(`导入完成：新增 ${added} 个收藏，跳过重复 ${skipped} 个`);
  } catch (e) {
    alert('导入失败：' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

/* ---------- 编辑标签弹窗 ---------- */

function openEditDlg(url) {
  editingUrl = url;
  const c = allCards().find((x) => x.url === url) || trashCards.find((x) => x.url === url);
  $('#editCardTitle').textContent = c ? c.title : url;
  renderEditChips();
  $('#tagInput').value = '';
  const known = new Set();
  for (const u of Object.keys(cardTags)) for (const t of tagsOf(u)) known.add(t);
  $('#tagSuggestions').innerHTML = [...known].map((t) => `<option value="${escapeHtml(t)}">`).join('');
  $('#editDlg').showModal();
}

function renderEditChips() {
  const box = $('#editChips');
  box.textContent = '';
  const tags = tagsOf(editingUrl);
  if (!tags.length) {
    const tip = document.createElement('span');
    tip.className = 'muted';
    tip.style.fontSize = '13px';
    tip.textContent = '暂无标签';
    box.appendChild(tip);
  }
  for (const t of tags) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.append(t + ' ');
    const x = document.createElement('span');
    x.className = 'x';
    x.textContent = '×';
    x.addEventListener('click', async () => {
      cardTags[editingUrl] = { tags: tagsOf(editingUrl).filter((v) => v !== t) };
      await saveTags();
      renderEditChips();
      renderAll();
    });
    chip.appendChild(x);
    box.appendChild(chip);
  }
}

async function addTagFromInput() {
  const t = $('#tagInput').value.trim().replace(/^#/, '');
  if (!t || !editingUrl) return;
  const tags = tagsOf(editingUrl);
  if (!tags.includes(t)) {
    cardTags[editingUrl] = { tags: [...tags, t] };
    await saveTags();
    renderEditChips();
    renderAll();
  }
  $('#tagInput').value = '';
}

/* ---------- 背景与外观 ---------- */

// bg 取值：'grad:xxx' | 'url:静态图片' | 'daily:URL（含 {date} 占位符）' | 'bing'
function resolveBgUrl() {
  const bg = settings.bg || 'grad:aurora';
  if (bg === 'bing') return settings.bingCache?.url || '';
  let u = bg;
  if (u.startsWith('url:') || u.startsWith('daily:')) u = u.slice(u.indexOf(':') + 1);
  if (u.includes('{date}')) u = u.replaceAll('{date}', todayStr());
  return u;
}

function applyBg() {
  const bg = settings.bg || 'grad:aurora';
  const el = $('#bg');
  if (bg.startsWith('grad:')) {
    el.style.background = GRADIENTS[bg.slice(5)] || GRADIENTS.aurora;
    return;
  }
  const u = resolveBgUrl();
  if (!u) {
    el.style.background = GRADIENTS.aurora; // 必应图未取到前的兜底
    return;
  }
  el.style.background = `url("${u.replace(/"/g, '')}") center / cover no-repeat`;
}

// 卡片磨砂不透明度：调 CSS 变量，所有玻璃元素实时生效
function applyGlass() {
  const o = Math.min(0.6, Math.max(0.05, parseFloat(settings.glassOpacity) || 0.13));
  const r = document.documentElement.style;
  r.setProperty('--glass', `rgba(255, 255, 255, ${o.toFixed(3)})`);
  r.setProperty('--glass-strong', `rgba(255, 255, 255, ${Math.min(0.75, o + 0.09).toFixed(3)})`);
}

// 必应每日壁纸：每天抓一次新图并缓存；无权限/断网时继续用缓存
async function refreshBingBg() {
  const today = todayStr();
  if (settings.bingCache?.date === today && settings.bingCache.url) return;
  try {
    const resp = await fetch(BING_API);
    const data = await resp.json();
    const img = data?.images?.[0];
    if (img?.url) {
      const url = /^https?:/i.test(img.url) ? img.url : 'https://cn.bing.com' + img.url;
      settings.bingCache = { date: today, url };
      await saveSettings();
      applyBg();
    }
  } catch {
    /* 无权限或网络失败：沿用缓存/兜底渐变 */
  }
}

// 选中订阅源时向用户申请 cn.bing.com 的跨域权限
async function ensureBingPermission() {
  try {
    const origin = 'https://cn.bing.com/*';
    const has = await chrome.permissions.contains({ origins: [origin] });
    if (!has) await chrome.permissions.request({ origins: [origin] });
  } catch {
    /* 拒绝权限时先靠缓存/兜底 */
  }
}

function renderBgSwatches() {
  const box = $('#bgSwatches');
  box.textContent = '';
  for (const [name, css] of Object.entries(GRADIENTS)) {
    const sw = document.createElement('div');
    sw.className = 'swatch' + (settings.bg === 'grad:' + name ? ' active' : '');
    sw.style.background = css;
    sw.title = name;
    sw.addEventListener('click', async () => {
      settings.bg = 'grad:' + name;
      await saveSettings();
      applyBg();
      renderBgSwatches();
      updateSubActive();
    });
    box.appendChild(sw);
  }
}

function updateSubActive() {
  const bg = settings.bg || 'grad:aurora';
  $('#bgDailyBtn').classList.toggle('active', bg.startsWith('daily:'));
  $('#bgBingBtn').classList.toggle('active', bg === 'bing');
}

/* ---------- WebDAV 同步 ---------- *
 *
 * 配置加密方案：
 * - 用户设置「加密口令」，PBKDF2(SHA-256, 150k 次) 派生 AES-256-GCM 密钥
 * - WebDAV 地址/账号/密码整体加密后存 chrome.storage.local（密文 + salt + iv）
 * - 派生密钥只缓存在 chrome.storage.session（纯内存，浏览器关闭即清空），口令永不落盘
 * - 浏览器重启后处于「锁定」状态，输入口令解锁后才能上传/拉取
 */

const PBKDF2_ITERS = 150000;

function bytesToB64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function b64ToBytes(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function deriveKey(pass, saltBytes) {
  const base = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBytes, iterations: PBKDF2_ITERS, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

// 会话密钥缓存（仅内存，浏览器重启即失效）
async function getSessionKey() {
  const { davKey } = await chrome.storage.session.get('davKey');
  if (!davKey) return null;
  try {
    return await crypto.subtle.importKey(
      'raw', b64ToBytes(davKey), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']
    );
  } catch {
    return null;
  }
}

async function cacheSessionKey(key) {
  const raw = await crypto.subtle.exportKey('raw', key);
  await chrome.storage.session.set({ davKey: bytesToB64(raw) });
}

// 返回解密后的 { url, username, password }；未配置/未解锁时抛错
async function getDavConfig() {
  if (!encConfig) throw new Error('请先在「⇅ 同步」中配置 WebDAV');
  const key = await getSessionKey();
  if (!key) throw new Error('LOCKED');
  const raw = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64ToBytes(encConfig.iv) }, key, b64ToBytes(encConfig.ct)
  );
  return JSON.parse(new TextDecoder().decode(raw));
}

async function unlockSync(pass) {
  if (!encConfig) throw new Error('尚未保存配置');
  const key = await deriveKey(pass, b64ToBytes(encConfig.salt));
  const raw = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64ToBytes(encConfig.iv) }, key, b64ToBytes(encConfig.ct)
  );
  await cacheSessionKey(key);
  return JSON.parse(new TextDecoder().decode(raw));
}

function davUrls(cfgUrl) {
  let u = (cfgUrl || '').trim().replace(/\/+$/, '');
  if (/\.json$/i.test(u)) return { file: u, dir: u.replace(/[^/]*$/, '') };
  return { file: u + '/' + SYNC_FILE, dir: u };
}

// 404 透传给调用方处理（拉取时区分「云端无数据」）
async function davRequest(method, url, body) {
  const cfg = await getDavConfig();
  const headers = { Authorization: 'Basic ' + btoa(`${cfg.username}:${cfg.password}`) };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const resp = await fetch(url, { method, headers, body });
  // 405 = 目录已存在，视为成功；404 透传
  if (!resp.ok && !(method === 'MKCOL' && resp.status === 405) && resp.status !== 404) {
    throw new Error(`${method} ${resp.status} ${resp.statusText}`);
  }
  return resp;
}

async function syncUpload() {
  const cfg = await getDavConfig();
  const { file, dir } = davUrls(cfg.url);
  await davRequest('MKCOL', dir).catch(() => {}); // 目录已存在等错误忽略
  const { syncStamp = 0 } = await chrome.storage.local.get('syncStamp');
  const payload = {
    version: 1,
    updatedAt: syncStamp || Date.now(),
    cardTags,
    // 只同步与设备无关的设置；侧栏开合/分组折叠等个人偏好不同步
    settings: {
      bg: settings.bg,
      bingCache: settings.bingCache,
      layoutN: settings.layoutN,
      glassOpacity: settings.glassOpacity,
    },
  };
  await davRequest('PUT', file, JSON.stringify(payload, null, 2));
  await chrome.storage.local.set({ syncStamp: payload.updatedAt });
  return `已上传（${new Date(payload.updatedAt).toLocaleString()}）`;
}

async function syncDownload() {
  const cfg = await getDavConfig();
  const { file } = davUrls(cfg.url);
  const resp = await davRequest('GET', file);
  if (resp.status === 404) throw new Error('云端还没有同步数据，请先在其他设备上传');
  const payload = await resp.json();
  if (!payload || typeof payload !== 'object') throw new Error('云端数据格式不正确');

  const { syncStamp = 0 } = await chrome.storage.local.get('syncStamp');
  if ((payload.updatedAt || 0) < syncStamp) {
    const ok = confirm(
      `云端数据（${new Date(payload.updatedAt).toLocaleString()}）比本地（${new Date(syncStamp).toLocaleString()}）旧，确定仍要用云端覆盖本地吗？`
    );
    if (!ok) return '已取消拉取';
  }

  cardTags = payload.cardTags || {};
  const s = payload.settings || {};
  if (s.bg) settings.bg = s.bg;
  if (s.bingCache) settings.bingCache = s.bingCache;
  if (Number.isInteger(s.layoutN) && s.layoutN >= 2 && s.layoutN <= 8) settings.layoutN = s.layoutN;
  if (typeof s.glassOpacity === 'number') settings.glassOpacity = s.glassOpacity;
  await saveTags();
  await saveSettings();
  await chrome.storage.local.set({ syncStamp: payload.updatedAt || Date.now() });
  await loadAll();
  applyGlass();
  renderAll();
  return `已拉取（${new Date(payload.updatedAt).toLocaleString()}，${Object.keys(cardTags).length} 条标签）`;
}

async function saveSyncConfig() {
  const url = $('#syncUrl').value.trim();
  const username = $('#syncUser').value.trim();
  const davPass = $('#syncPass').value;
  const master = $('#syncMaster').value;
  if (!url) {
    $('#syncStatus').textContent = '请填写服务器地址';
    return;
  }
  if (!master) {
    $('#syncStatus').textContent = '请设置加密口令（用于加密本机保存的账号密码）';
    return;
  }
  // 向用户申请该 WebDAV 服务器的跨域访问权限
  try {
    const origin = new URL(url).origin + '/*';
    const has = await chrome.permissions.contains({ origins: [origin] });
    if (!has) await chrome.permissions.request({ origins: [origin] });
  } catch {
    /* 用户拒绝权限时仍可保存，但请求会失败 */
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(master, salt);
  const plain = JSON.stringify({ url, username, password: davPass });
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain)
  );
  encConfig = { v: 1, salt: bytesToB64(salt), iv: bytesToB64(iv), ct: bytesToB64(ct) };
  await chrome.storage.local.set({ syncConfig: encConfig });
  await cacheSessionKey(key);
  $('#syncStatus').textContent = '✓ 配置已加密保存并解锁';
}

/* ---------- UI 事件绑定 ---------- */

function bindUI() {
  document.body.classList.toggle('collapsed', !!settings.sidebarCollapsed);
  bindSidebarResizer();

  // 侧边栏折叠（把手吸附在侧边栏右缘，随面板一起移动）
  const st = $('#sideToggle');
  st.textContent = settings.sidebarCollapsed ? '›' : '‹';
  st.title = settings.sidebarCollapsed ? '展开侧边栏' : '收起侧边栏';
  st.addEventListener('click', async () => {
    settings.sidebarCollapsed = !settings.sidebarCollapsed;
    document.body.classList.toggle('collapsed', settings.sidebarCollapsed);
    st.textContent = settings.sidebarCollapsed ? '›' : '‹';
    st.title = settings.sidebarCollapsed ? '展开侧边栏' : '收起侧边栏';
    await saveSettings();
    alignStickyTop();
    setTimeout(alignStickyTop, 300); // 折叠动画结束后再校准一次
  });

  // 搜索
  $('#search').addEventListener('input', (e) => {
    view.q = e.target.value.trim();
    renderGrid();
    renderHeader();
  });

  // 视图徽标：点击返回全部收藏（清空所有过滤条件）
  $('#viewBadge').addEventListener('click', () => {
    view.mode = 'wall';
    view.tag = null;
    view.group = null;
    view.q = '';
    $('#search').value = '';
    renderAll();
  });

  // 标签条：点击 tag 过滤（再次点击取消）
  $('#tagBar').addEventListener('click', (e) => {
    const chip = e.target.closest('.tchip');
    if (!chip) return;
    const t = chip.dataset.tag;
    view.tag = view.tag === t ? null : t;
    renderAll();
  });
  $('#tagToggle').addEventListener('click', () => {
    tagsExpanded = !tagsExpanded;
    $('#tagBarWrap').classList.toggle('expanded', tagsExpanded);
    $('#tagToggle').textContent = tagsExpanded ? '▴' : '▾';
  });

  // 视图切换
  $('#trashBtn').addEventListener('click', () => {
    view.mode = view.mode === 'trash' ? 'wall' : 'trash';
    view.tag = null;
    view.group = null;
    renderAll();
  });

  // 拖卡片到「回收站」按钮 = 移入回收站
  const trashBtn = $('#trashBtn');
  trashBtn.addEventListener('dragover', (e) => {
    if (!dragState || dragState.isTrash) return;
    // 目录树常驻侧边栏：任何视图下拖目录到回收站都应可用；卡片拖动仅在卡片墙视图
    if (!dragState.isFolder && view.mode !== 'wall') return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    trashBtn.classList.add('drop-hover');
  });
  trashBtn.addEventListener('dragleave', () => trashBtn.classList.remove('drop-hover'));
  trashBtn.addEventListener('drop', async (e) => {
    e.preventDefault();
    trashBtn.classList.remove('drop-hover');
    if (!dragState || dragState.isTrash) return;
    if (dragState.isFolder) await trashFolder(dragState); // 拖目录 = 目录内全部收藏移入回收站
    else await trashCard(dragState.card);
  });

  // 一键导入书签
  $('#importBtn').addEventListener('click', runImport);

  $('#emptyTrashBtn').addEventListener('click', async () => {
    if (trashCards.length && confirm(`确定清空回收站吗？将彻底删除 ${trashCards.length} 个书签，此操作不可恢复。`)) {
      await emptyTrash();
    }
  });

  // 编辑标签
  $('#tagAddBtn').addEventListener('click', addTagFromInput);
  $('#tagInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addTagFromInput();
  });
  $('#editDoneBtn').addEventListener('click', () => $('#editDlg').close());

  // 设置面板（背景 / 布局 / WebDAV 同步）
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#glassOpacity').addEventListener('input', (e) => {
    const o = parseInt(e.target.value, 10) / 100;
    $('#glassVal').textContent = e.target.value;
    settings.glassOpacity = o;
    applyGlass(); // 实时预览，弹窗关闭时统一保存
  });
  $('#bgDailyBtn').addEventListener('click', async () => {
    settings.bg = 'daily:' + DAILY_RANDOM_URL;
    await saveSettings();
    applyBg();
    updateSubActive();
    $('#bgUrl').value = DAILY_RANDOM_URL;
  });
  $('#bgBingBtn').addEventListener('click', async () => {
    await ensureBingPermission();
    settings.bg = 'bing';
    await saveSettings();
    applyBg();
    await refreshBingBg();
    updateSubActive();
    $('#bgUrl').value = '';
  });
  $('#bgDoneBtn').addEventListener('click', async () => {
    const u = $('#bgUrl').value.trim();
    if (u && /^https?:\/\//i.test(u)) {
      settings.bg = (u.includes('{date}') ? 'daily:' : 'url:') + u;
      applyBg();
    }
    const n = parseInt($('#layoutN').value, 10);
    if (Number.isInteger(n) && n >= 2 && n <= 8) settings.layoutN = n;
    await saveSettings();
    applyGlass();
    renderAll();
    $('#settingsDlg').close();
  });

  // WebDAV 同步（按钮都在设置面板内）
  $('#syncSaveBtn').addEventListener('click', saveSyncConfig);
  $('#syncUnlockBtn').addEventListener('click', async () => {
    const pass = $('#syncMaster').value;
    if (!pass) {
      $('#syncStatus').textContent = '请输入加密口令';
      return;
    }
    try {
      const cfg = await unlockSync(pass);
      fillSyncFields(cfg);
      $('#syncStatus').textContent = '🔓 已解锁，可以上传/拉取了';
    } catch {
      $('#syncStatus').textContent = '✗ 口令错误或数据损坏';
    }
  });
  $('#syncUpBtn').addEventListener('click', () => runSync(syncUpload, '上传中…'));
  $('#syncDownBtn').addEventListener('click', () => runSync(syncDownload, '拉取中…'));

  // 窗口尺寸变化时重新对齐搜索栏宽度
  window.addEventListener('resize', alignStickyTop);
}

function fillSyncFields(cfg) {
  $('#syncUrl').value = cfg.url || '';
  $('#syncUser').value = cfg.username || '';
  $('#syncPass').value = cfg.password || '';
}

// 打开设置面板：填充背景/布局与 WebDAV 两区的状态
async function openSettings() {
  renderBgSwatches();
  updateSubActive();
  $('#layoutN').value = layoutN();
  const bg = settings.bg || 'grad:aurora';
  const raw = bg.startsWith('url:') || bg.startsWith('daily:') ? bg.slice(bg.indexOf(':') + 1) : '';
  $('#bgUrl').value = raw;
  const o = Math.round((settings.glassOpacity || 0.13) * 100);
  $('#glassOpacity').value = o;
  $('#glassVal').textContent = o;
  await updateSyncPane('');
  $('#settingsDlg').showModal();
}

// 根据 WebDAV 配置的加密状态填充面板（不负责打开弹窗）
async function updateSyncPane(prefillStatus) {
  let state = 'none';
  if (encConfig) state = (await getSessionKey()) ? 'unlocked' : 'locked';

  if (state === 'unlocked') {
    try {
      fillSyncFields(await getDavConfig());
    } catch { /* 不阻塞面板 */ }
    $('#syncStatus').textContent = prefillStatus || '🔓 已解锁';
  } else if (state === 'locked') {
    $('#syncUrl').value = '';
    $('#syncUser').value = '';
    $('#syncPass').value = '';
    $('#syncStatus').textContent = prefillStatus || '🔒 配置已加密锁定，输入口令后点「解锁」';
  } else {
    $('#syncUrl').value = '';
    $('#syncUser').value = '';
    $('#syncPass').value = '';
    $('#syncStatus').textContent = prefillStatus || '';
  }
  $('#syncMaster').value = '';
}

async function runSync(fn, doing) {
  // 未解锁时在面板内提示（设置面板已处于打开状态）
  if (encConfig && !(await getSessionKey())) {
    $('#syncStatus').textContent = '🔒 已锁定，请先输入口令解锁';
    return;
  }
  $('#syncStatus').textContent = doing;
  try {
    $('#syncStatus').textContent = '✓ ' + (await fn());
  } catch (err) {
    $('#syncStatus').textContent = err.message === 'LOCKED'
      ? '🔒 已锁定，请先解锁' : '✗ ' + err.message;
  }
}
