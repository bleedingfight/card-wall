/* ===== 收藏位置选择器：展示卡片墙目录树，选择后创建书签 ===== */
const $ = (s) => document.querySelector(s);

const params = new URLSearchParams(location.search);
const url = params.get('url') || '';
let title = params.get('title') || url;
const wallId = params.get('folder');

let selectedId = wallId;

$('#pTitle').value = title;
$('#pUrl').textContent = url;

function select(el, fid) {
  selectedId = fid;
  document.querySelectorAll('.prow').forEach((x) => x.classList.remove('sel'));
  el.classList.add('sel');
}

function buildTree(nodes, depth, container) {
  for (const n of nodes) {
    if (n.url) continue; // 只展示目录
    const row = document.createElement('div');
    row.className = 'prow';
    row.dataset.fid = n.id;
    row.style.paddingLeft = 10 + depth * 16 + 'px';
    row.textContent = '📁 ' + (n.title || '未命名');
    container.appendChild(row);
    buildTree(n.children || [], depth + 1, container);
  }
}

const list = $('#pFolders');
list.addEventListener('click', (e) => {
  const row = e.target.closest('.prow');
  if (row) select(row, row.dataset.fid);
});

chrome.bookmarks.getSubTree(wallId).then(([root]) => {
  const rootRow = document.createElement('div');
  rootRow.className = 'prow sel';
  rootRow.dataset.fid = wallId;
  rootRow.textContent = '📌 卡片墙（根目录）';
  list.appendChild(rootRow);
  buildTree(root.children, 1, list);
});

$('#pSave').addEventListener('click', async () => {
  const t = $('#pTitle').value.trim() || url;
  try {
    await chrome.bookmarks.create({ parentId: selectedId, title: t, url });
  } catch (err) {
    alert('收藏失败：' + err.message);
    return;
  }
  window.close();
});

$('#pCancel').addEventListener('click', () => window.close());
