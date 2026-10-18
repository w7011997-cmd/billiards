/**
 * Lets a game controller play by "pressing" the same keys the keyboard uses.
 * Left stick / D-pad: aim. Right stick: spin. A: hold for power, release to shoot.
 */
const DEAD = 0.25 // ignore tiny stick wobble
const FINE = 0.6 // a light push aims slowly

export class GamepadInput {
  private readonly held = new Set<string>()
  private running = false

  constructor(private readonly kb: any) {
    if (typeof window === "undefined" || !navigator.getGamepads) return
    window.addEventListener("gamepadconnected", () => this.start())
    window.addEventListener("gamepaddisconnected", () => this.releaseAll())
    if (Array.from(navigator.getGamepads()).some((p) => !!p)) this.start()
  }

  private start() {
    if (this.running) return
    this.running = true
    requestAnimationFrame(this.tick)
  }

  private activePad(): Gamepad | null {
    for (const p of Array.from(navigator.getGamepads())) {
      if (p?.connected) return p
    }
    return null
  }

  private press(code: string) {
    this.kb.pressed[code] ??= performance.now()
    this.held.add(code)
  }

  private release(code: string) {
    const t0 = this.kb.pressed[code]
    if (t0 !== undefined) {
      this.kb.released[code] = performance.now() - t0
      delete this.kb.pressed[code]
    }
    this.held.delete(code)
  }

  private releaseAll() {
    for (const c of Array.from(this.held)) this.release(c)
  }

  private tick = () => {
    const pad = this.activePad()
    if (!pad) {
      this.releaseAll()
      this.running = false
      return
    }

    const btn = (i: number) => !!pad.buttons[i]?.pressed
    const axis = (i: number) => {
      const v = pad.axes[i] ?? 0
      return Math.abs(v) > DEAD ? v : 0
    }

    const want = new Set<string>()
    const rx = axis(2)
    const ry = axis(3)
    const left = btn(14) ? -1 : btn(15) ? 1 : axis(0)
    const vert = btn(12) ? -1 : btn(13) ? 1 : ry

    if (rx !== 0) {
      // right stick sideways = sideways spin (the game reads Shift + arrow)
      want.add("ShiftLeft")
      want.add(rx < 0 ? "ArrowLeft" : "ArrowRight")
    } else if (left !== 0) {
      want.add(left < 0 ? "ArrowLeft" : "ArrowRight")
      if (Math.abs(left) < FINE) want.add("ControlLeft") // slow, fine aim
    }
    if (vert !== 0) want.add(vert < 0 ? "ArrowUp" : "ArrowDown")

    if (btn(0)) {
      want.add("Space")
      want.add("Enter")
    }
    if (btn(1)) want.add("KeyA")
    if (btn(3)) want.add("KeyO")
    if (btn(4)) want.add("NumpadSubtract")
    if (btn(5)) want.add("NumpadAdd")

    for (const c of Array.from(this.held)) if (!want.has(c)) this.release(c)
    for (const c of Array.from(want)) if (!this.held.has(c)) this.press(c)

    requestAnimationFrame(this.tick)
  }
}
