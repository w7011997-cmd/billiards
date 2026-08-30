import { Vector3 } from "three"
import { Container } from "../../container/container"
import { Ball } from "../../model/ball"
import { Outcome } from "../../model/outcome"
import { Table } from "../../model/table"
import { Controller } from "../controller"
import { Rules } from "./rules"
import { TableGeometry } from "../../view/tablegeometry"
import { TableConfig } from "../../view/tableconfig"
import { Rack } from "../../utils/rack"
import { isFirstShot } from "../../utils/utils"
import { R } from "../../model/physics/constants"
import { Session } from "../../network/client/session"
import { MatchResultHelper } from "../../network/client/matchresult"
import { Aim } from "../aim"
import { WatchAim } from "../watchaim"
import { PlaceBall } from "../placeball"
import { PlaceBallEvent } from "../../events/placeballevent"
import { WatchEvent } from "../../events/watchevent"
import { StartAimEvent } from "../../events/startaimevent"
import { Respot } from "../../utils/respot"
import { RerackEvent } from "../../events/rerackevent"
import { roundVec } from "../../utils/three-utils"

export class SniperPool implements Rules {
  readonly container: Container

  cueball: Ball
  currentBreak = 0
  previousBreak = 0
  rulename = "sniperpool"

  constructor(container: Container) {
    this.container = container
  }

  readonly asset = "models/p8.min.gltf"

  startTurn(): void {
    this.previousBreak = this.currentBreak
    this.currentBreak = 0
  }

  tableGeometry(): void {
    TableConfig.apply(this.rulename, TableConfig.tableSizeFromUrl())
  }

  table(): Table {
    const table = new Table(this.rack())
    this.cueball = table.cueball
    return table
  }

  rack(): Ball[] {
    return Rack.fromInitParam(Rack.eightBall())
  }

  secondToPlay(): void {
    // Intentionally empty
  }

  otherPlayersCueBall(): Ball {
    return this.cueball
  }

  isPartOfBreak(_outcome: Outcome[]): boolean {
    return this.currentBreak > 0
  }

  allowsPlaceBall(): boolean {
    return true
  }

  placeBall(target?: Vector3): Vector3 {
    if (target) {
      const max = new Vector3(TableGeometry.tableX, TableGeometry.tableY)
      const min = new Vector3(-TableGeometry.tableX, -TableGeometry.tableY)
      if (isFirstShot(this.container.recorder)) {
        const baulkline = (-R * 11) / 0.5
        max.setX(baulkline)
        min.setX(baulkline)
      }
      return target.clone().clamp(min, max)
    }
    const baulkline = (-R * 11) / 0.5
    return new Vector3(baulkline, 0, 0)
  }

  nextCandidateBall(_p1type?: number): Ball | undefined {
    const table = this.container.table
    return table.balls.find((b) => b !== this.cueball && b.onTable())
  }

  private ballValue(ball: Ball): number {
    return ball.label === 8 ? 2 : 1
  }

  foulReason(outcome: Outcome[]): string | null {
    const table = this.container.table
    const cueball = table.cueball

    if (Outcome.isCueBallPotted(cueball, outcome)) {
      return "Cue ball potted (scratch)"
    }

    const firstCollision = Outcome.firstCollision(
      Outcome.cueBallFirst(cueball, outcome)
    )
    if (!firstCollision) {
      return "No ball hit"
    }

    return null
  }

  isEndOfGame(_outcome: Outcome[]): boolean {
    return Outcome.isClearTable(this.container.table)
  }

  getAmountScored(outcome: Outcome[]): number {
    if (this.foulReason(outcome)) {
      return 0
    }
    return Outcome.pots(outcome).reduce(
      (sum, ball) => sum + this.ballValue(ball),
      0
    )
  }

  respot(outcome: Outcome[]): Ball[] {
    if (!this.foulReason(outcome)) {
      return []
    }
    const table = this.container.table
    const footSpot = new Vector3(TableGeometry.tableX / 2, 0, 0)
    return Outcome.pots(outcome)
      .filter((b) => b !== table.cueball)
      .map((ball) => Respot.respotBehind(footSpot, ball, table))
  }

  update(outcome: Outcome[]): Controller {
    const reason = this.foulReason(outcome)
    if (reason) {
      return this.handleFoul(outcome, reason)
    }

    const pots = Outcome.pots(outcome)
    if (pots.length > 0) {
      return this.handlePot(outcome, pots)
    }

    return this.handleMiss()
  }

  private handleFoul(outcome: Outcome[], reason: string): Controller {
    const session = Session.getInstance()
    const isScratch = reason.startsWith("Cue ball potted")

    try {
      this.respotAndSend(outcome)

      if (session.myScore() > 0) {
        session.addMyScore(-1)
      } else {
        session.addOpponentScore(1)
      }

      this.container.notify({
        type: "Foul",
        title: "FOUL",
        subtext: reason,
        extra: isScratch ? "Ball in hand" : undefined,
      })

      this.startTurn()

      if (isScratch) {
        const cueball = this.container.table.cueball
        const startPos = cueball.onTable()
          ? cueball.pos.clone()
          : this.placeBall()
        roundVec(startPos)
        this.container.sendEvent(
          new PlaceBallEvent(startPos, undefined, true)
        )
        if (this.container.isSinglePlayer) {
          return new PlaceBall(this.container, startPos)
        }
        return new WatchAim(this.container)
      }

      this.container.sendEvent(new StartAimEvent())
      if (this.container.isSinglePlayer) {
        this.container.sendEvent(
          new WatchEvent(this.container.table.serialise())
        )
        return new Aim(this.container)
      }
      return new WatchAim(this.container)
    } catch (err) {
      this.container.notify({
        type: "Foul",
        title: "DEBUG ERROR (screenshot this)",
        subtext: String(err),
      })
      this.startTurn()
      this.container.sendEvent(new StartAimEvent())
      if (this.container.isSinglePlayer) {
        return new Aim(this.container)
      }
      return new WatchAim(this.container)
    }
  }

  private handlePot(outcome: Outcome[], pots: Ball[]): Controller {
    try {
      const session = Session.getInstance()
      const gained = pots.reduce((sum, ball) => sum + this.ballValue(ball), 0)
      this.currentBreak += gained
      session.addMyScore(gained)

      const table = this.container.table
      this.container.sound.playSuccess(table.inPockets())

      if (this.isEndOfGame(outcome)) {
        const isWinner = session.myScore() > session.opponentScore()
        return this.handleGameEnd(isWinner)
      }

      this.container.sendEvent(new WatchEvent(table.serialise()))
      return new Aim(this.container)
    } catch (err) {
      this.container.notify({
        type: "Foul",
        title: "DEBUG ERROR (screenshot this)",
        subtext: String(err),
      })
      this.container.sendEvent(new WatchEvent(this.container.table.serialise()))
      return new Aim(this.container)
    }
  }

  private handleMiss(): Controller {
    try {
      const table = this.container.table
      this.container.sendEvent(new StartAimEvent())
      if (this.container.isSinglePlayer) {
        this.container.sendEvent(new WatchEvent(table.serialise()))
        this.startTurn()
        return new Aim(this.container)
      }
      return new WatchAim(this.container)
    } catch (err) {
      this.container.notify({
        type: "Foul",
        title: "DEBUG ERROR (screenshot this)",
        subtext: String(err),
      })
      this.startTurn()
      return new WatchAim(this.container)
    }
  }

  private respotAndSend(outcome: Outcome[]): void {
    const respotted = this.respot(outcome)
    if (respotted.length > 0) {
      respotted.forEach((ball) => ball.fround())
      this.container.sendEvent(
        RerackEvent.fromJson({ balls: respotted.map((b) => b.serialise()) })
      )
    }
  }

  handleGameEnd(isWinner: boolean, endSubtext?: string): Controller {
    return MatchResultHelper.presentGameEnd(
      this.container,
      this.rulename,
      isWinner,
      endSubtext
    )
  }
}
