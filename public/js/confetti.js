/* Confetti — palette sauge/or/rose + accents saturés, salves multiples,
   particules plus grosses et plus contrastées pour rester lisibles
   sur un fond crème. */
(function () {
  // Palette mixte : pastels accordés à la charte + 3 accents saturés
  // (vert vif, rose vif, or franc) pour que CHAQUE confetti se voie
  // distinctement sur le fond crème. Les pastels donnent la cohérence
  // chromatique, les saturés assurent la lecture visuelle.
  const palette = [
    // pastels (charte)
    '#9CAF88', '#7E926A', '#5F6F4F',          // sauges
    '#E6C9C0', '#D9A89C', '#A86A5C',          // roses
    '#C9A961', '#8A6A1F',                     // ors
    '#FBF8F1',                                // crème blanche
    // accents saturés (visibilité contrastée)
    '#4F8B3A',  // vert sauge vif
    '#E14D6A',  // rose magenta
    '#F0B940',  // or doré clair
    '#B91E4A'   // rouge framboise (rare, pour pop)
  ];

  function launch({ duration = 12000 } = {}) {
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

    function spawnParticle(sideHint) {
      // sideHint : 'left' | 'right' | 'top' (top = "centre haut, retombe en pluie")
      const side = sideHint || (Math.random() < .4 ? 'top' : (Math.random() < .5 ? 'left' : 'right'));
      let x, y, vx, vy;
      if (side === 'top') {
        // Salve depuis le haut, projete vers le bas avec dispersion
        x = (W() * 0.2 + Math.random() * W() * 0.6);
        y = -20 * dpr;
        vx = (Math.random() - .5) * 6 * dpr;
        vy = (2 + Math.random() * 4) * dpr;
      } else if (side === 'left') {
        x = -10 * dpr;
        y = H() * (.15 + Math.random() * .35);
        vx = (7 + Math.random() * 10) * dpr;
        vy = (-12 - Math.random() * 10) * dpr;
      } else {
        x = W() + 10 * dpr;
        y = H() * (.15 + Math.random() * .35);
        vx = -(7 + Math.random() * 10) * dpr;
        vy = (-12 - Math.random() * 10) * dpr;
      }
      // Mix de tailles : 70% standard, 25% gros, 5% tres gros pour des "phares"
      const r = Math.random();
      const size = r < .05 ? (16 + Math.random() * 6) * dpr
                 : r < .30 ? (10 + Math.random() * 4) * dpr
                 :          (6  + Math.random() * 4) * dpr;
      // Shapes variees : carre, cercle, etoile, triangle
      const shapes = ['circle', 'rect', 'rect', 'tri', 'star'];
      return {
        x, y, vx, vy,
        g: 0.32 * dpr,
        size,
        rot: Math.random() * Math.PI * 2,
        vr: (Math.random() - .5) * .3,
        color: palette[(Math.random() * palette.length) | 0],
        shape: shapes[(Math.random() * shapes.length) | 0],
        life: 1
      };
    }

    // Salve initiale
    function burst(n, sideHint) {
      for (let i = 0; i < n; i++) parts.push(spawnParticle(sideHint));
    }
    burst(140);  // grosse salve d'ouverture

    // Salves additionnelles a intervalles aleatoires sur la duree
    const salvoTimers = [];
    function scheduleNextSalvo() {
      const elapsed = performance.now() - start;
      if (elapsed > duration - 500) return; // plus assez de temps
      const delay = 500 + Math.random() * 1400; // 0.5s a 1.9s
      const t = setTimeout(() => {
        const sides = ['left', 'right', 'top'];
        burst(50 + ((Math.random() * 40) | 0), sides[(Math.random() * sides.length) | 0]);
        scheduleNextSalvo();
      }, delay);
      salvoTimers.push(t);
    }

    const start = performance.now();
    scheduleNextSalvo();

    function drawStar(ctx, size) {
      // etoile 5 branches simplifiee
      const outer = size / 2, inner = outer * .45;
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const r = i % 2 ? inner : outer;
        const a = (Math.PI / 5) * i - Math.PI / 2;
        const x = Math.cos(a) * r, y = Math.sin(a) * r;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
    }

    function drawTriangle(ctx, size) {
      const h = size * .88;
      ctx.beginPath();
      ctx.moveTo(0, -h / 2);
      ctx.lineTo(size / 2, h / 2);
      ctx.lineTo(-size / 2, h / 2);
      ctx.closePath();
      ctx.fill();
    }

    function frame(now) {
      const t = now - start;
      ctx.clearRect(0, 0, W(), H());
      for (const p of parts) {
        if (p.life <= 0) continue;
        p.vy += p.g;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        p.vx *= 0.996;
        if (p.y > H() + 40 * dpr) { p.life = 0; continue; }
        if (p.x < -40 * dpr || p.x > W() + 40 * dpr) { p.life = 0; continue; }
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        // Drop shadow plus prononcée pour decoller du fond cream
        ctx.shadowColor = 'rgba(58,71,48,.45)';
        ctx.shadowBlur = 6 * dpr;
        ctx.shadowOffsetY = 2 * dpr;
        if (p.shape === 'rect') {
          // Rectangle elance type "ruban"
          ctx.fillRect(-p.size / 2, -p.size / 3.5, p.size, p.size / 1.8);
        } else if (p.shape === 'circle') {
          ctx.beginPath();
          ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
          ctx.fill();
        } else if (p.shape === 'tri') {
          drawTriangle(ctx, p.size);
        } else if (p.shape === 'star') {
          drawStar(ctx, p.size);
        }
        ctx.restore();
      }
      if (t < duration) {
        requestAnimationFrame(frame);
      } else {
        ctx.clearRect(0, 0, W(), H());
        canvas.classList.remove('active');
        salvoTimers.forEach(clearTimeout);
      }
    }
    requestAnimationFrame(frame);
  }

  window.DanceConfetti = { launch };
})();
