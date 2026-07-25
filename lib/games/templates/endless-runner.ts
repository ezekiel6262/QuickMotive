export interface GameTemplateParams {
  title: string;
  characterImageUrl: string;
}

/** Self-contained playable page: character auto-runs, jump to clear obstacles, score by survival time. */
export function renderEndlessRunner(params: GameTemplateParams): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(params.title)}</title>
<style>
  html, body { margin: 0; height: 100%; background: #1a1a2e; display: flex; align-items: center; justify-content: center; font-family: system-ui, sans-serif; }
  canvas { background: linear-gradient(#1a1a2e, #16213e); border: 2px solid #0f3460; touch-action: none; }
  #hud { position: fixed; top: 16px; left: 16px; color: #e94560; font-size: 20px; font-weight: bold; }
  #msg { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); color: #fff; text-align: center; font-size: 18px; display: none; }
</style>
</head>
<body>
<div id="hud">Score: 0</div>
<div id="msg">Game Over<br/><span style="font-size:14px">Press Space or tap to restart</span></div>
<canvas id="c" width="480" height="270"></canvas>
<script>
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const hud = document.getElementById('hud');
const msgEl = document.getElementById('msg');
const img = new Image();
img.src = ${JSON.stringify(params.characterImageUrl)};

const GROUND_Y = 220;
const GRAVITY = 0.9;
const JUMP_V = -13;

let player, obstacles, score, speed, running, lastSpawn;

function reset() {
  player = { x: 60, y: GROUND_Y - 40, w: 40, h: 40, vy: 0, jumping: false };
  obstacles = [];
  score = 0;
  speed = 4;
  running = true;
  lastSpawn = 0;
  msgEl.style.display = 'none';
}

function jump() {
  if (!running) { reset(); return; }
  if (!player.jumping) { player.vy = JUMP_V; player.jumping = true; }
}

document.addEventListener('keydown', (e) => { if (e.code === 'Space') { e.preventDefault(); jump(); } });
canvas.addEventListener('pointerdown', jump);

function spawnObstacle() {
  const h = 24 + Math.random() * 24;
  obstacles.push({ x: canvas.width, y: GROUND_Y - h, w: 20, h });
}

function update() {
  if (!running) return;
  player.vy += GRAVITY;
  player.y += player.vy;
  if (player.y >= GROUND_Y - player.h) {
    player.y = GROUND_Y - player.h;
    player.vy = 0;
    player.jumping = false;
  }

  lastSpawn++;
  if (lastSpawn > 70 - Math.min(speed * 4, 40)) {
    spawnObstacle();
    lastSpawn = 0;
  }

  for (const o of obstacles) o.x -= speed;
  obstacles = obstacles.filter((o) => o.x + o.w > 0);

  for (const o of obstacles) {
    if (player.x < o.x + o.w && player.x + player.w > o.x && player.y < o.y + o.h && player.y + player.h > o.y) {
      running = false;
      msgEl.style.display = 'block';
    }
  }

  score += 1;
  speed += 0.002;
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#0f3460';
  ctx.fillRect(0, GROUND_Y, canvas.width, canvas.height - GROUND_Y);

  if (img.complete && img.naturalWidth > 0) {
    ctx.drawImage(img, player.x, player.y, player.w, player.h);
  } else {
    ctx.fillStyle = '#e94560';
    ctx.fillRect(player.x, player.y, player.w, player.h);
  }

  ctx.fillStyle = '#533483';
  for (const o of obstacles) ctx.fillRect(o.x, o.y, o.w, o.h);

  hud.textContent = 'Score: ' + Math.floor(score / 5);
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
