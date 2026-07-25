import type { GameTemplateParams } from "./endless-runner";

/** Self-contained playable page: click-swap adjacent tiles to make 3-in-a-rows. Character art is one of the tile types, worth double points. */
export function renderMatch3(params: GameTemplateParams): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(params.title)}</title>
<style>
  html, body { margin: 0; height: 100%; background: #22223b; display: flex; flex-direction: column; align-items: center; justify-content: center; font-family: system-ui, sans-serif; gap: 12px; }
  canvas { background: #4a4e69; border-radius: 8px; touch-action: none; }
  #hud { color: #fff; font-size: 20px; font-weight: bold; }
</style>
</head>
<body>
<div id="hud">Score: 0</div>
<canvas id="c" width="336" height="336"></canvas>
<script>
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const hud = document.getElementById('hud');
const img = new Image();
img.src = ${JSON.stringify(params.characterImageUrl)};

const SIZE = 6;
const TILE = 56;
const COLORS = ['#e94560', '#f4d35e', '#3a7d44', '#4a90d9', '#9b59b6'];
const CHAR_TYPE = COLORS.length;
let score = 0;
let grid = [];
let selected = null;

function randType() {
  return Math.floor(Math.random() * (COLORS.length + 1));
}

function initGrid() {
  grid = [];
  for (let r = 0; r < SIZE; r++) {
    const row = [];
    for (let c = 0; c < SIZE; c++) row.push(randType());
    grid.push(row);
  }
}

function findMatches() {
  const matched = new Set();
  for (let r = 0; r < SIZE; r++) {
    let run = 1;
    for (let c = 1; c <= SIZE; c++) {
      if (c < SIZE && grid[r][c] === grid[r][c - 1]) run++;
      else {
        if (run >= 3) for (let k = c - run; k < c; k++) matched.add(r + ',' + k);
        run = 1;
      }
    }
  }
  for (let c = 0; c < SIZE; c++) {
    let run = 1;
    for (let r = 1; r <= SIZE; r++) {
      if (r < SIZE && grid[r][c] === grid[r - 1][c]) run++;
      else {
        if (run >= 3) for (let k = r - run; k < r; k++) matched.add(k + ',' + c);
        run = 1;
      }
    }
  }
  return matched;
}

function clearAndRefill(matched) {
  let gained = 0;
  for (const key of matched) {
    const [r, c] = key.split(',').map(Number);
    gained += grid[r][c] === CHAR_TYPE ? 20 : 10;
    grid[r][c] = -1;
  }
  for (let c = 0; c < SIZE; c++) {
    const col = [];
    for (let r = 0; r < SIZE; r++) if (grid[r][c] !== -1) col.push(grid[r][c]);
    while (col.length < SIZE) col.unshift(randType());
    for (let r = 0; r < SIZE; r++) grid[r][c] = col[r];
  }
  score += gained;
  hud.textContent = 'Score: ' + score;
}

function cellAt(px, py) {
  const c = Math.floor(px / TILE);
  const r = Math.floor(py / TILE);
  if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) return null;
  return { r, c };
}

function adjacent(a, b) {
  return Math.abs(a.r - b.r) + Math.abs(a.c - b.c) === 1;
}

canvas.addEventListener('pointerdown', (e) => {
  const rect = canvas.getBoundingClientRect();
  const cell = cellAt(e.clientX - rect.left, e.clientY - rect.top);
  if (!cell) return;

  if (!selected) {
    selected = cell;
    return;
  }
  if (selected.r === cell.r && selected.c === cell.c) {
    selected = null;
    return;
  }
  if (adjacent(selected, cell)) {
    const tmp = grid[selected.r][selected.c];
    grid[selected.r][selected.c] = grid[cell.r][cell.c];
    grid[cell.r][cell.c] = tmp;

    const matched = findMatches();
    if (matched.size > 0) {
      clearAndRefill(matched);
    } else {
      const tmp2 = grid[selected.r][selected.c];
      grid[selected.r][selected.c] = grid[cell.r][cell.c];
      grid[cell.r][cell.c] = tmp2;
    }
    selected = null;
  } else {
    selected = cell;
  }
});

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const x = c * TILE;
      const y = r * TILE;
      const type = grid[r][c];
      if (type === CHAR_TYPE && img.complete && img.naturalWidth > 0) {
        ctx.drawImage(img, x + 4, y + 4, TILE - 8, TILE - 8);
      } else {
        ctx.fillStyle = COLORS[type] || '#888';
        ctx.beginPath();
        ctx.roundRect(x + 4, y + 4, TILE - 8, TILE - 8, 8);
        ctx.fill();
      }
      if (selected && selected.r === r && selected.c === c) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 3;
        ctx.strokeRect(x + 2, y + 2, TILE - 4, TILE - 4);
      }
    }
  }
  requestAnimationFrame(draw);
}

initGrid();
while (findMatches().size > 0) initGrid();
draw();
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
