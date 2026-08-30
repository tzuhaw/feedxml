"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";

/**
 * The hero's motion is the system's own behaviour, not decoration: records
 * stream left to right, meet the validation gate, and most pass. A small
 * fraction turn amber and fall away — the Skipped records — and once in a
 * while the gate flares and holds the whole stream back for a moment, which
 * is what a halted run looks like from the outside.
 *
 * Deliberately cheap: 3,500 points on one BufferGeometry, positions updated
 * on the CPU. Honours prefers-reduced-motion and pauses when the tab is hidden.
 */

const COUNT = 3500;
const SPAN_X = 34;
const GATE_X = 4;

type Particle = {
  x: number;
  y: number;
  z: number;
  speed: number;
  skipped: boolean;
  fall: number;
};

export default function FeedStream() {
  const mount = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = mount.current;
    if (!el) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    el.appendChild(renderer.domElement);
    renderer.domElement.style.display = "block";
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 120);
    camera.position.set(0, 1.1, 17);
    camera.lookAt(0, 0, 0);

    // Colours mirror the documents: teal for records in flight, amber for the
    // ones the gate sets aside.
    const flowing = new THREE.Color(dark ? "#5fbdb4" : "#16706a");
    const skipped = new THREE.Color(dark ? "#dda047" : "#a2620a");

    const particles: Particle[] = [];
    const positions = new Float32Array(COUNT * 3);
    const colors = new Float32Array(COUNT * 3);

    const reset = (p: Particle, atStart: boolean): void => {
      p.x = atStart ? -SPAN_X / 2 - Math.random() * 6 : Math.random() * SPAN_X - SPAN_X / 2;
      p.y = (Math.random() - 0.5) * 5.2;
      p.z = (Math.random() - 0.5) * 7;
      p.speed = 0.045 + Math.random() * 0.075;
      p.skipped = Math.random() < 0.04;
      p.fall = 0;
    };

    for (let i = 0; i < COUNT; i++) {
      const p: Particle = { x: 0, y: 0, z: 0, speed: 0, skipped: false, fall: 0 };
      reset(p, false);
      particles.push(p);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
      size: 0.075,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity: dark ? 0.92 : 0.8,
      depthWrite: false,
      blending: dark ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    const points = new THREE.Points(geometry, material);
    scene.add(points);

    // The gate itself: a faint vertical seam the stream passes through.
    const gateGeom = new THREE.PlaneGeometry(0.045, 6.4);
    const gateMat = new THREE.MeshBasicMaterial({
      color: skipped,
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
    });
    const gate = new THREE.Mesh(gateGeom, gateMat);
    gate.position.set(GATE_X, 0, 0);
    scene.add(gate);

    const resize = (): void => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(el);

    // A halt: every so often the gate flares and the stream stalls against it.
    let haltUntil = 0;
    let nextHalt = performance.now() + 9000 + Math.random() * 7000;

    const write = (): void => {
      for (let i = 0; i < COUNT; i++) {
        const p = particles[i]!;
        positions[i * 3] = p.x;
        positions[i * 3 + 1] = p.y - p.fall;
        positions[i * 3 + 2] = p.z;

        // Fade in from the left edge and out to the right, so the band has no
        // hard boundaries.
        const edge = Math.min(1, (p.x + SPAN_X / 2) / 5, (SPAN_X / 2 - p.x) / 6);
        const c = p.skipped && p.x > GATE_X - 0.4 ? skipped : flowing;
        const k = Math.max(0, edge) * (p.fall > 0 ? Math.max(0, 1 - p.fall / 3) : 1);
        colors[i * 3] = c.r * k;
        colors[i * 3 + 1] = c.g * k;
        colors[i * 3 + 2] = c.b * k;
      }
      geometry.attributes.position.needsUpdate = true;
      geometry.attributes.color.needsUpdate = true;
    };

    let raf = 0;
    const tick = (now: number): void => {
      raf = requestAnimationFrame(tick);

      if (now > nextHalt) {
        haltUntil = now + 1600;
        nextHalt = now + 11000 + Math.random() * 9000;
      }
      const halted = now < haltUntil;
      gateMat.opacity = halted ? 0.5 : 0.18;

      for (let i = 0; i < COUNT; i++) {
        const p = particles[i]!;
        // While halted, nothing crosses the gate — the stream backs up against it.
        const blocked = halted && p.x > GATE_X - 0.15 && p.x < GATE_X + 0.15;
        if (!blocked) p.x += p.speed;

        if (p.skipped && p.x > GATE_X) p.fall += 0.028;
        if (p.x > SPAN_X / 2 || p.fall > 3.4) reset(p, true);
      }

      write();
      camera.position.x = Math.sin(now / 9000) * 0.9;
      camera.lookAt(0, 0, 0);
      renderer.render(scene, camera);
    };

    if (reduced) {
      write();
      renderer.render(scene, camera);
    } else {
      raf = requestAnimationFrame(tick);
    }

    const onVisibility = (): void => {
      if (document.hidden) {
        cancelAnimationFrame(raf);
      } else if (!reduced) {
        raf = requestAnimationFrame(tick);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVisibility);
      observer.disconnect();
      geometry.dispose();
      material.dispose();
      gateGeom.dispose();
      gateMat.dispose();
      renderer.dispose();
      el.removeChild(renderer.domElement);
    };
  }, []);

  return <div ref={mount} aria-hidden="true" className="stream" />;
}
