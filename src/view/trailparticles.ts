import {
  BufferGeometry,
  BufferAttribute,
  Points,
  PointsMaterial,
  AdditiveBlending,
  Color,
  Vector3,
} from "three"

export interface TrailStyle {
  colour: string | number
  /** Particles spawned per world-unit of distance the ball travels. */
  density: number
  /** Uniform point size in world units (PointsMaterial has no native
   * per-vertex size attribute, so size is constant — fading is done via
   * colour instead, see below). */
  size: number
  /** Seconds before a particle fully fades. */
  life: number
  /** Drift per second along +up (table's Z axis). Positive rises (embers),
   * negative sinks (falling ice shards). */
  drift: number
  /** Random positional jitter radius at spawn, and continued per-frame. */
  spread: number
  /** Ambient particles spawned per second, hugging the ball's surface, even
   * while it's stationary — the always-on "aura" while a trail is equipped. */
  auraDensity: number
  /** Particle count fired once, radially, at the instant the ball is struck. */
  burstCount: number
  /** Outward speed (world units/sec) burst particles fly at. */
  burstSpeed: number
}

/**
 * Buckets a colour by hue/saturation into a rough particle "feel" so each
 * trail looks distinct without needing a stored per-item style field —
 * warm reds/oranges read as fire, blues as ice/electric, purples as cosmic,
 * golds as sparks, and low-saturation colours as smoke. Falls back to a
 * generic energy preset outside those ranges.
 */
export function styleForColour(hex: string | number): TrailStyle {
  const c = new Color(hex)
  const hsl = { h: 0, s: 0, l: 0 }
  c.getHSL(hsl)
  const hue = hsl.h * 360

  const base = { colour: hex }

  if (hsl.s < 0.15) {
    return { ...base, density: 25, size: 0.012, life: 0.9, drift: 0.025, spread: 0.009, auraDensity: 10, burstCount: 25, burstSpeed: 0.1 }
  }
  if (hue >= 15 && hue < 55) {
    return { ...base, density: 45, size: 0.006, life: 0.4, drift: 0.012, spread: 0.003, auraDensity: 18, burstCount: 55, burstSpeed: 0.35 }
  }
  if (hue < 15 || hue >= 340) {
    return { ...base, density: 55, size: 0.008, life: 0.45, drift: 0.045, spread: 0.005, auraDensity: 20, burstCount: 65, burstSpeed: 0.4 }
  }
  if (hue >= 180 && hue < 230) {
    return { ...base, density: 40, size: 0.0055, life: 0.5, drift: -0.008, spread: 0.005, auraDensity: 14, burstCount: 40, burstSpeed: 0.25 }
  }
  if (hue >= 250 && hue < 300) {
    return { ...base, density: 35, size: 0.006, life: 0.6, drift: 0.008, spread: 0.011, auraDensity: 12, burstCount: 45, burstSpeed: 0.2 }
  }
  return { ...base, density: 40, size: 0.007, life: 0.5, drift: 0.018, spread: 0.006, auraDensity: 15, burstCount: 45, burstSpeed: 0.25 }
}

/**
 * Always-on, fixed-capacity, allocation-free particle trail for the cue
 * ball — distinct from Trace (the hidden-by-default analysis/replay line).
 * Three spawn sources share one ring buffer: `addTrace` (particles along the
 * path while moving), `updateAura` (a light trickle hugging the ball's
 * surface at all times, the ambient "energy" look), and `burst` (a one-time
 * radial spawn fired the instant the ball is struck). Fading is achieved by
 * darkening each particle's colour toward black over its life under
 * AdditiveBlending, so a dark particle visually vanishes without needing
 * per-vertex alpha or size (neither of which PointsMaterial supports
 * natively). Dead particles are recycled via a ring-buffer cursor rather
 * than removed, keeping the draw call size constant.
 */
export class TrailParticles {
  readonly points: Points
  private readonly geometry: BufferGeometry
  private readonly positions: Float32Array
  private readonly colors: Float32Array
  private readonly velocities: Float32Array
  private readonly ages: Float32Array
  private readonly maxAges: Float32Array
  private cursor = 0
  private readonly capacity: number
  private style: TrailStyle
  private baseColour: Color
  private distanceSinceSpawn = 0
  private auraAccum = 0
  private readonly lastPos = new Vector3()
  private hasLastPos = false

  constructor(style: TrailStyle, capacity = 320) {
    this.style = style
    this.capacity = capacity
    this.baseColour = new Color(style.colour)

    this.positions = new Float32Array(capacity * 3)
    this.colors = new Float32Array(capacity * 3)
    this.velocities = new Float32Array(capacity * 3)
    this.ages = new Float32Array(capacity).fill(Infinity)
    this.maxAges = new Float32Array(capacity)

    this.geometry = new BufferGeometry()
    this.geometry.setAttribute("position", new BufferAttribute(this.positions, 3))
    this.geometry.setAttribute("color", new BufferAttribute(this.colors, 3))

    const material = new PointsMaterial({
      size: style.size,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      sizeAttenuation: true,
    })

    this.points = new Points(this.geometry, material)
    this.points.frustumCulled = false
  }

  /** Swaps the active theme in place (e.g. turn changed to a player with a
   * different equipped trail) without recreating the Points object. */
  setStyle(style: TrailStyle) {
    this.style = style
    this.baseColour = new Color(style.colour)
    ;(this.points.material as PointsMaterial).size = style.size
    this.reset()
  }

  reset() {
    this.ages.fill(Infinity)
    this.hasLastPos = false
    this.distanceSinceSpawn = 0
    this.auraAccum = 0
    this.colors.fill(0)
    this.geometry.attributes.color.needsUpdate = true
  }

  /** Call whenever the ball's position actually changed this frame. */
  addTrace(pos: Vector3) {
    if (!this.hasLastPos) {
      this.lastPos.copy(pos)
      this.hasLastPos = true
      return
    }
    const dist = this.lastPos.distanceTo(pos)
    this.distanceSinceSpawn += dist
    const spawnEvery = 1 / this.style.density
    let guard = 0
    while (this.distanceSinceSpawn >= spawnEvery && guard < 12) {
      this.spawnAt(pos, 0, 0)
      this.distanceSinceSpawn -= spawnEvery
      guard++
    }
    this.lastPos.copy(pos)
  }

  /** Light continuous trickle hugging the ball's current position, whether
   * it's moving or not — the always-on ambient "aura". Call every frame;
   * `radius` should be the ball's physical radius so particles sit right at
   * its surface rather than its center. */
  updateAura(pos: Vector3, dt: number, radius: number) {
    if (dt <= 0 || this.style.auraDensity <= 0) return
    this.auraAccum += dt
    const spawnEvery = 1 / this.style.auraDensity
    let guard = 0
    while (this.auraAccum >= spawnEvery && guard < 6) {
      this.spawnAt(pos, radius, 0)
      this.auraAccum -= spawnEvery
      guard++
    }
  }

  /** One-time radial burst fired the instant the ball is struck. */
  burst(pos: Vector3) {
    for (let n = 0; n < this.style.burstCount; n++) {
      this.spawnAt(pos, 0, this.style.burstSpeed)
    }
  }

  /** Shared spawn: places a particle at `pos`, optionally offset by `radius`
   * in a random spherical direction (for surface-hugging aura placement),
   * with outward radial velocity of `speed` in that same direction (for the
   * burst) plus the style's usual jitter/drift. `radius=0, speed=0` is the
   * plain trailing-particle behaviour used by `addTrace`. */
  private spawnAt(pos: Vector3, radius: number, speed: number) {
    const i = this.cursor
    this.cursor = (this.cursor + 1) % this.capacity
    const s = this.style.spread

    const theta = Math.random() * Math.PI * 2
    const phi = Math.acos(2 * Math.random() - 1)
    const dx = Math.sin(phi) * Math.cos(theta)
    const dy = Math.sin(phi) * Math.sin(theta)
    const dz = Math.cos(phi)

    this.positions[i * 3] = pos.x + dx * radius + (Math.random() - 0.5) * s
    this.positions[i * 3 + 1] = pos.y + dy * radius + (Math.random() - 0.5) * s
    this.positions[i * 3 + 2] = pos.z + dz * radius + (Math.random() - 0.5) * s

    this.velocities[i * 3] = dx * speed + (Math.random() - 0.5) * s
    this.velocities[i * 3 + 1] = dy * speed + (Math.random() - 0.5) * s
    this.velocities[i * 3 + 2] = dz * speed + this.style.drift + (Math.random() - 0.5) * s

    this.ages[i] = 0
    this.maxAges[i] = this.style.life * (0.7 + Math.random() * 0.6)

    this.colors[i * 3] = this.baseColour.r
    this.colors[i * 3 + 1] = this.baseColour.g
    this.colors[i * 3 + 2] = this.baseColour.b
  }

  /** Call every frame (ball moving or not) to age, drift and fade existing
   * particles toward black — under additive blending a black particle
   * contributes nothing, i.e. it visually disappears. */
  update(dt: number) {
    if (dt <= 0) return
    let changed = false
    for (let i = 0; i < this.capacity; i++) {
      if (this.ages[i] === Infinity) continue
      this.ages[i] += dt
      const t = this.ages[i] / this.maxAges[i]
      if (t >= 1) {
        this.ages[i] = Infinity
        this.colors[i * 3] = 0
        this.colors[i * 3 + 1] = 0
        this.colors[i * 3 + 2] = 0
        changed = true
        continue
      }
      this.positions[i * 3] += this.velocities[i * 3] * dt
      this.positions[i * 3 + 1] += this.velocities[i * 3 + 1] * dt
      this.positions[i * 3 + 2] += this.velocities[i * 3 + 2] * dt

      const fade = 1 - t
      this.colors[i * 3] = this.baseColour.r * fade
      this.colors[i * 3 + 1] = this.baseColour.g * fade
      this.colors[i * 3 + 2] = this.baseColour.b * fade
      changed = true
    }
    if (changed) {
      this.geometry.attributes.position.needsUpdate = true
      this.geometry.attributes.color.needsUpdate = true
    }
  }
}
