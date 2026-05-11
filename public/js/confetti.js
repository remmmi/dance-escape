/* Tiny confetti — sage/gold/rose */
(function () {
  const palette = ['#9CAF88', '#C9A961', '#E6C9C0', '#D9A89C', '#7E926A', '#FBF8F1'];

  function launch({ duration = 5000, particleCount = 220 } = {}) {
    const canvas = document.getElementById('confetti');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;

    function resize() {
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      canvas.style.width = window.innerWidth + 'px';
      canvas.style.height = window.innerHeight + 'px';
    }
    resize();
    window.addEventListener('resize', resize);
    canvas.classList.add('active');

    const W = () => canvas.width;
    const H = () => canvas.height;

    const parts = [];
    for (let i = 0; i < particleCount; i++) {
      parts.push(spawn(i / particleCount));
    }

    function spawn(t) {
      const fromLeft = Math.random() < .5;
      return {
        x: (fromLeft ? 0 : W()) + (Math.random() * 60 - 30) * dpr,
        y: H() * (.2 + Math.random() * .3),
        vx: ((fromLeft ? 1 : -1) * (6 + Math.random() * 9)) * dpr,
        vy: (-10 - Math.random() * 9) * dpr,
        g: 0.35 * dpr,
        size: (5 + Math.random() * 6) * dpr,
        rot: Math.random() * Math.PI * 2,
        vr: (Math.random() - .5) * .25,
        color: palette[(Math.random() * palette.length) | 0],
        shape: Math.random() < .35 ? 'rect' : 'circle',
        life: 1
      };
    }

    const start = performance.now();
    function frame(now) {
      const t = now - start;
      ctx.clearRect(0, 0, W(), H());
      for (const p of parts) {
        p.vy += p.g;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        p.vx *= 0.995;
        if (p.y > H() + 40 * dpr) p.life = 0;
        if (p.life <= 0) continue;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.shadowColor = 'rgba(75,90,64,.25)';
        ctx.shadowBlur = 4 * dpr;
        if (p.shape === 'rect') {
          ctx.fillRect(-p.size / 2, -p.size / 3, p.size, p.size / 1.6);
        } else {
          ctx.beginPath();
          ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
      if (t < duration) {
        requestAnimationFrame(frame);
      } else {
        ctx.clearRect(0, 0, W(), H());
        canvas.classList.remove('active');
      }
    }
    requestAnimationFrame(frame);
  }

  window.DanceConfetti = { launch };
})();
