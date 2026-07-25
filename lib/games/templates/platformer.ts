import type { GameTemplateParams } from "./endless-runner";

/** Self-contained playable page: move + jump across static platforms to reach the flag. */
export function renderPlatformer(params: GameTemplateParams): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(params.title)}</title>
<style>
  html, body { margin: 0; height: 100%; background: #202040; display: flex; align-items: center; justify-content: center; font-family: system-ui, sans-serif; }
  canvas { background: linear-gradient(#87ceeb, #4a90d9); border: 2px solid #202040; touch-action: none; }
  #hud { position: fixed; top: 16px; left: 16px; color: #fff; font-size: 18px; font-weight: bold; }
  #msg { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); color: #fff; text-align: center; font-size: 20px; display: none; background: rgba(0,0,0,0.6); padding: 16px 24px; border-radius: 8px; }
  #controls { position: fixed; bottom: 16px; color: #fff; font-size: 12px; opacity: 0.7; }
</style>
</head>
<body>
<div id="hud">Reach the flag!</div>
<div id="msg">You Win!<br/><span style="font-size:14px">Press R or tap to play again</span></div>
<div id="controls">Arrow keys / A-D to move, Space to jump</div>
<canvas id="c" width="640" height="320"></canvas>
<script>
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const msgEl = document.getElementById('msg');
const img = new Image();
img.src = ${JSON.stringify(params.characterImageUrl)};

const GRAVITY = 0.7;
const platforms = [
  { x: 0, y: 300, w: 640, h: 20 },
  { x: 140, y: 240, w: 100, h: 16 },
  { x: 300, y: 190, w: 100, h: 16 },
  { x: 460, y: 240, w: 100, h: 16 },
  { x: 560, y: 180, w: 60, h: 16 }
];
const goal = { x: 580, y: 140, w: 24, h: 40 };

let player, keys, won;

function reset() {
  player = { x: 20, y: 260, w: 32, h: 40, vx: 0, vy: 0, onGround: false };
  keys = {};
  won = false;
  msgEl.style.display = 'none';
}

document.addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (e.code === 'Space') e.preventDefault();
  if (won && (e.code === 'KeyR' || e.code === 'Space')) reset();
});
document.addEventListener('keyup', (e) => { keys[e.code] = false; });
canvas.addEventListener('pointerdown', () => { if (won) reset(); });

function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function update() {
  if (won) return;

  const speed = 3.2;
  if (keys['ArrowLeft'] || keys['KeyA']) player.vx = -speed;
  else if (keys['ArrowRight'] || keys['KeyD']) player.vx = speed;
  else player.vx = 0;

  if ((keys['Space'] || keys['ArrowUp'] || keys['KeyW']) && player.onGround) {
    player.vy = -12;
    player.onGround = false;
  }

  player.vy += GRAVITY;
  player.x += player.vx;
  player.y += player.vy;
  player.onGround = false;

  for (const p of platforms) {
    const feet = { x: player.x, y: player.y + player.h - 4, w: player.w, h: 8 };
    if (rectsOverlap(feet, p) && player.vy >= 0) {
      player.y = p.y - player.h;
      player.vy = 0;
      player.onGround = true;
    }
  }

  if (player.y > canvas.height) reset();
  player.x = Math.max(0, Math.min(canvas.width - player.w, player.x));

  if (rectsOverlap(player, goal)) {
    won = true;
    msgEl.style.display = 'block';
  }
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = '#3a7d44';
  for (const p of platforms) ctx.fillRect(p.x, p.y, p.w, p.h);

  ctx.fillStyle = '#f4d35e';
  ctx.fillRect(goal.x, goal.y, goal.w, goal.h);
  ctx.fillStyle = '#e94560';
  ctx.fillRect(goal.x, goal.y, 4, goal.h);

  if (img.complete && img.naturalWidth > 0) {
    ctx.drawImage(img, player.x, player.y, player.w, player.h);
  } else {
    ctx.fillStyle = '#e94560';
    ctx.fillRect(player.x, player.y, player.w, player.h);
  }
}

function loop() {
  update();
  draw();
  requestAnimationFrame(loop);
}

reset();
loop();
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
