"use client";

// Ports the mock's drawChart() (docs/design/dashboard-mock.html) to a
// component: faint grid, brass area line, endpoint dot + "$X today" label.
// Redraws on window resize and whenever the root's data-theme attribute
// changes (the chrome's theme toggle swaps CSS custom properties in place),
// and respects devicePixelRatio for crisp rendering on HiDPI screens.
import { useEffect, useRef } from "react";

export function RevChart({ daily }: { daily: number[] }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    function draw() {
      const cv = canvasRef.current;
      if (!cv) return;
      const ctx = cv.getContext("2d");
      if (!ctx) return;

      const css = getComputedStyle(document.documentElement);
      const brass = css.getPropertyValue("--brass").trim();
      const line = css.getPropertyValue("--line").trim();
      const ink3 = css.getPropertyValue("--ink3").trim();

      const dpr = window.devicePixelRatio || 1;
      const w = cv.clientWidth;
      const h = 150;
      cv.width = w * dpr;
      cv.height = h * dpr;
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, w, h);

      const data = daily.length > 0 ? daily : [0];
      const max = Math.max(...data, 1);
      const pad = 6;
      const bw = (w - pad * 2) / data.length;

      /* faint grid */
      ctx.strokeStyle = line;
      ctx.lineWidth = 1;
      [0.25, 0.5, 0.75].forEach((g) => {
        ctx.beginPath();
        ctx.moveTo(0, h * g);
        ctx.lineTo(w, h * g);
        ctx.stroke();
      });

      /* area */
      ctx.beginPath();
      ctx.moveTo(pad, h - (data[0] / max) * h);
      data.forEach((v, i) => {
        ctx.lineTo(pad + i * bw, h - (v / max) * (h - 14));
      });
      ctx.strokeStyle = brass;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.lineTo(pad + (data.length - 1) * bw, h);
      ctx.lineTo(pad, h);
      ctx.closePath();
      ctx.fillStyle = `${brass}22`;
      ctx.fill();

      /* endpoint */
      const ex = pad + (data.length - 1) * bw;
      const ey = h - (data[data.length - 1] / max) * (h - 14);
      ctx.beginPath();
      ctx.arc(ex, ey, 3.5, 0, 7);
      ctx.fillStyle = brass;
      ctx.fill();

      ctx.fillStyle = ink3;
      ctx.font = "11px -apple-system,sans-serif";
      const today = data[data.length - 1].toFixed(2);
      ctx.fillText(`$${today} today`, ex - 78, ey - 8);
    }

    draw();

    window.addEventListener("resize", draw);
    const observer = new MutationObserver(draw);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    return () => {
      window.removeEventListener("resize", draw);
      observer.disconnect();
    };
  }, [daily]);

  return <canvas ref={canvasRef} height={150} style={{ width: "100%", marginTop: 8 }} />;
}
