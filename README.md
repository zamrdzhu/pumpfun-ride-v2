# Completion Ride v2

[![Competition](https://img.shields.io/badge/make.fun-Pump.fun%20Replay%20Sprint-blue)](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![Entry](https://img.shields.io/badge/entry-Completion%20Ride%20v2-green)](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper-trading bot for the [Pump.fun Replay Sprint](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) on make.fun. It trades a simulated 10 SOL bankroll over a recorded day of pump.fun bonding-curve activity; nothing here touches real funds.

## The strategy, in plain words

Most new curves fade within seconds. The ones worth riding are the ones that are already deep — at least 55 SOL of real reserves — and still pulling in clearly more buying than selling over the last thirty seconds. When a curve shows that shape, the bot takes a single modest position (never more than 1 SOL, never a second bite at the same mint) and then manages it tightly:

- **Cut** the whole position on a 12% drop, a collapse in net flow, or a stall — a minute old with reserves barely above where it entered.
- **Trail** winners: once a position is up 30% at its peak, an 18% fall from that peak ends the ride.
- **Bank** half the position at +60%, and everything at +160%.
- **Leave** after five minutes no matter what, so capital is never parked in a dead curve.

Everything is decided from event timestamps in the replay itself — no wall clock, no randomness — so the same data always produces the same orders.

## Layout

- `main.ts` — the whole strategy: flow tracking, entries, exits.
- `vendor/makefun-bot.ts` — the kit's TypeScript shim for the `agent-fun/replay/v2` protocol, copied unchanged from the competition kit.

## Running it

The grader runs `node main.ts` and speaks the replay protocol over stdin/stdout. There are no dependencies and no build step; Node 22 strips the types as it goes.
