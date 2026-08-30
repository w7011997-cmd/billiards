import { Vector2, Raycaster } from "three"
import type { Container } from "../container/container"
import type { Ball } from "../model/ball"

const TAP_SLOP_PX = 12
const TAP_MS = 500

/**
 * Touch-only tap-to-aim: tapping directly on a ball snaps the cue's aim
 * angle to point at it, using the same aimAtBall() finishing steps as a
 * drag would (limits, rotation, overlap helper, cue/ball clip avoidance),
 * then syncs the resulting aim over the network exactly like a drag does.
 *
 * Deliberately scoped to touch only so it never collides with PointerTap,
 * which owns tap behaviour for mouse/trackpad (toggling its own adjust
 * mode). Owned by Container and armed only while Aim is active.
 */
export class BallTap {
  private readonly container: Container
  private armed = false
  private startX = 0
  private startY = 0
  private startT = 0
  private pointerId: number | null = null
  private removeListeners: (() => void) | null = null
  private readonly raycaster = new Raycaster()
  private readonly ndc = new Vector2()

  constructor(container: Container) {
    this.container = container
  }

  enable() {
    this.armed = true
    if (this.removeListeners) {
      return
    }
    const canvas = this.container.view.element as HTMLElement | undefined
    if (!canvas) {
      return
    }
    canvas.addEventListener("pointerdown", this.onPointerDown)
    canvas.addEventListener("pointerup", this.onPointerUp)
    this.removeListeners = () => {
      canvas.removeEventListener("pointerdown", this.onPointerDown)
      canvas.removeEventListener("pointerup", this.onPointerUp)
    }
  }

  disable() {
    this.armed = false
    this.pointerId = null
    this.removeListeners?.()
    this.removeListeners = null
  }

  private gestureOwned(): boolean {
    return !!(
      this.container.cueHit?.active ||
      this.container.cueBallSpin?.active ||
      this.container.pointerTap?.adjusting
    )
  }

  private onPointerDown = (e: PointerEvent) => {
    if (
      !this.armed ||
      !e.isPrimary ||
      e.pointerType !== "touch" ||
      this.gestureOwned()
    ) {
      return
    }
    if ((e.target as Element | null)?.closest?.("#inputTextDiv")) {
      return
    }
    this.pointerId = e.pointerId
    this.startX = e.clientX
    this.startY = e.clientY
    this.startT = performance.now()
  }

  private onPointerUp = (e: PointerEvent) => {
    if (!this.armed || e.pointerId !== this.pointerId || this.gestureOwned()) {
      this.pointerId = null
      return
    }
    this.pointerId = null
    const dx = e.clientX - this.startX
    const dy = e.clientY - this.startY
    if (
      Math.hypot(dx, dy) >= TAP_SLOP_PX ||
      performance.now() - this.startT >= TAP_MS
    ) {
      return
    }
    this.tryAimAtTappedBall(e.clientX, e.clientY)
  }

  private tryAimAtTappedBall(clientX: number, clientY: number) {
    const canvas = this.container.view.element as HTMLElement | undefined
    const camera = this.container.view.camera?.camera
    if (!canvas || !camera) {
      return
    }

    const rect = canvas.getBoundingClientRect()
    this.ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    )
    this.raycaster.setFromCamera(this.ndc, camera)

    const table = this.container.table
    const candidates = table.balls.filter(
      (b: Ball) => b !== table.cueball && b.onTable()
    )
    const targets = candidates.map((b: Ball) => b.ballmesh.mesh)
    const hits = this.raycaster.intersectObjects(targets, true)
    if (hits.length === 0) {
      return
    }

    const hitObject = hits[0].object
    const ball = candidates.find(
      (b: Ball) =>
        b.ballmesh.mesh === hitObject ||
        b.ballmesh.mesh.getObjectById(hitObject.id)
    )
    if (!ball) {
      return
    }

    table.cue.aimAtBall(ball, table)
    this.container.sendEvent(table.cue.aim)
  }
}
