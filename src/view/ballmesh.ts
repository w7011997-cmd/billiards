import {
  IcosahedronGeometry,
  Matrix4,
  Mesh,
  MeshPhongMaterial,
  CircleGeometry,
  MeshBasicMaterial,
  ArrowHelper,
  Color,
  BufferAttribute,
  Vector3,
  MeshStandardMaterial,
  MeshPhysicalMaterial,
  Scene,
  Line,
} from "three"
import { State } from "../model/ball"
import { norm, up, zero } from "./../utils/three-utils"
import { R } from "../model/physics/constants"
import { Trace } from "./trace"
import { TrailParticles, styleForColour } from "./trailparticles"
import { BallMaterialFactory } from "./ballmaterialfactory"
import { Session } from "../network/client/session"
import { BallAppearance } from "./ballappearance"

export class BallMesh {
  private static _ballGeometry: IcosahedronGeometry
  private static _shadowGeometry: CircleGeometry
  private static _shadowMaterial: MeshBasicMaterial
  private static readonly _dottedGeometryCache = new Map<
    number,
    IcosahedronGeometry
  >()

  private static getBallGeometry() {
    if (!this._ballGeometry) {
      this._ballGeometry = new IcosahedronGeometry(
        R,
        Math.max(1, Session.getLod())
      )
    }
    return this._ballGeometry
  }

  private static getShadowGeometry() {
    if (!this._shadowGeometry) {
      this._shadowGeometry = new CircleGeometry(
        R * 0.9,
        Session.getLod() <= 1 ? 9 : 24
      )
      this._shadowGeometry.applyMatrix4(
        new Matrix4().makeTranslation(0, 0, -R * 0.99)
      )
    }
    return this._shadowGeometry
  }

  private static getShadowMaterial() {
    if (!this._shadowMaterial) {
      this._shadowMaterial = new MeshBasicMaterial({ color: 0x111122 })
    }
    return this._shadowMaterial
  }

  mesh: Mesh
  shadow: Mesh
  spinAxisArrow: ArrowHelper
  trace: Trace
  /**
   * Purely cosmetic per-shot particle trail (distinct from `trace`, which
   * only shows during Replay/analysis via Table.showTraces). Undefined
   * unless `enableCosmeticTrail` was called — currently only done for the
   * cue ball, from Container, driven by session.customParams/opponentParams
   * "trail.colour" and switched on turn change via setCosmeticTrailColour.
   */
  cosmeticTrail?: TrailParticles
  private wasStationary = true
  color: Color
  private ghosts: Line[] = []

  freezeTrace(scene: Scene) {
    const count = this.trace.geometry.drawRange.count
    if (count > 1) {
      const ghost = this.trace.freeze()
      this.ghosts.push(ghost)
      scene.add(ghost)
    }
  }

  clearGhosts(scene: Scene) {
    this.ghosts.forEach((g) => scene.remove(g))
    this.ghosts = []
  }
  constructor(color, label?: number, appearance?: BallAppearance) {
    this.color = new Color(color)
    this.initialiseMesh(this.color, label, appearance)
  }

  /**
   * Enables the always-on cosmetic particle trail with the given colour's
   * auto-picked theme. Safe to call once per ball, before or after
   * addToScene (addToScene picks it up if called after; call before
   * addToScene otherwise for it to appear).
   */
  enableCosmeticTrail(colour: string | number) {
    this.cosmeticTrail = new TrailParticles(styleForColour(colour))
  }

  /** Swaps the trail's active colour/theme in place — used when the active
   * shooter changes (mine vs opponent's equipped trail), without recreating
   * the underlying Points object. */
  setCosmeticTrailColour(colour: string | number) {
    this.cosmeticTrail?.setStyle(styleForColour(colour))
  }

  updateAll(ball, t) {
    this.cosmeticTrail?.update(t)
    this.cosmeticTrail?.updateAura(ball.pos, t, R)

    const isStationary = ball.state === State.Stationary
    const positionChanged = !this.mesh.position.equals(ball.pos)
    if (isStationary && !positionChanged) {
      return
    }

    if (this.cosmeticTrail) {
      if (this.wasStationary && !isStationary) {
        // Fresh trail each time the ball sets off from rest, so shots don't
        // visually chain into one long streak across a whole turn.
        this.cosmeticTrail.reset()
        this.cosmeticTrail.burst(ball.pos)
      }
      if (positionChanged) {
        this.cosmeticTrail.addTrace(ball.pos)
      }
    }
    this.wasStationary = isStationary

    this.updatePosition(ball.pos)
    if (this.spinAxisArrow.visible) {
      this.updateArrows(ball.pos, ball.rvel, ball.state)
    }
    if (ball.rvel.lengthSq() !== 0) {
      this.updateRotation(ball.rvel, t)
      this.trace.addTrace(ball.pos, ball.vel)
    }
  }

  updatePosition(pos) {
    this.mesh.position.copy(pos)
    this.shadow.position.copy(pos)
  }

  readonly m = new Matrix4()

  updateRotation(rvel, t) {
    const angle = rvel.length() * t
    this.mesh.rotateOnWorldAxis(norm(rvel), angle)
  }

  updateArrows(pos, rvel, state) {
    this.spinAxisArrow.setLength(R + (R * rvel.length()) / 2, R, R)
    this.spinAxisArrow.position.copy(pos)
    this.spinAxisArrow.setDirection(norm(rvel))
    if (state == State.Rolling) {
      this.spinAxisArrow.setColor(0xcc0000)
    } else {
      this.spinAxisArrow.setColor(0x00cc00)
    }
  }

  initialiseMesh(color: Color, label?: number, appearance?: BallAppearance) {
    let geometry: IcosahedronGeometry
    let material:
      MeshPhongMaterial | MeshStandardMaterial | MeshPhysicalMaterial
    const effectiveAppearance =
      appearance ?? (label === undefined ? "dotted" : "projected")

    if (effectiveAppearance === "dotted") {
      const key = color.getHex()
      let cached = BallMesh._dottedGeometryCache.get(key)
      if (!cached) {
        cached = new IcosahedronGeometry(R, Math.max(1, Session.getLod()))
        BallMesh.addDots(cached, color)
        BallMesh._dottedGeometryCache.set(key, cached)
      }
      geometry = cached
      material = BallMaterialFactory.createDottedMaterial(color)
    } else if (effectiveAppearance === "texturedDots") {
      geometry = BallMesh.getBallGeometry()
      material = BallMaterialFactory.createTexturedDotsMaterial(color)
    } else {
      if (label === undefined) {
        throw new Error("Projected ball material requires a label")
      }
      geometry = BallMesh.getBallGeometry()
      material = BallMaterialFactory.createProjectedMaterial(label, color)
    }
    this.mesh = new Mesh(geometry, material)
    this.mesh.name = "ball"
    this.updateRotation(new Vector3().random(), 100)

    this.shadow = new Mesh(
      BallMesh.getShadowGeometry(),
      BallMesh.getShadowMaterial()
    )
    this.spinAxisArrow = new ArrowHelper(up, zero, 2, 0x000000, 0.01, 0.01)
    this.spinAxisArrow.visible = false
    this.trace = new Trace(500, color)
  }

  private static addDots(geometry, baseColor) {
    const count = geometry.attributes.position.count
    const color = new Color(baseColor)

    geometry.setAttribute(
      "color",
      new BufferAttribute(new Float32Array(count * 3), 3)
    )

    const verticies = geometry.attributes.color
    for (let i = 0; i < count / 3; i++) {
      BallMesh.colorVerticesForFace(
        i,
        verticies,
        BallMesh.scaleNoise(color.r),
        BallMesh.scaleNoise(color.g),
        BallMesh.scaleNoise(color.b)
      )
    }

    const red = new Color(0xaa2222)
    const dots = [0, 96, 111, 156, 186, 195]
    dots.forEach((i) => {
      BallMesh.colorVerticesForFace(i / 3, verticies, red.r, red.g, red.b)
    })
  }

  addToScene(scene) {
    scene.add(this.mesh)
    scene.add(this.shadow)
    scene.add(this.spinAxisArrow)
    scene.add(this.trace.line)
    if (this.cosmeticTrail) {
      scene.add(this.cosmeticTrail.points)
    }
  }

  private static colorVerticesForFace(face, verticies, r, g, b) {
    verticies.setXYZ(face * 3 + 0, r, g, b)
    verticies.setXYZ(face * 3 + 1, r, g, b)
    verticies.setXYZ(face * 3 + 2, r, g, b)
  }

  private static scaleNoise(v) {
    return (1 - Math.random() * 0.25) * v
  }
}
