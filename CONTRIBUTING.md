# Contributing to bytelight

bytelight is a sovereign, single-operator deployment of a persistent AI companion framework. It is developed in the open where useful, but it is not a community product with a roadmap by committee — the architecture serves one household and is opinionated on purpose.

## What's welcome

- **Bug reports** — [GitHub Issues](https://github.com/kaydartistry-maker/bytelight-public/issues). Include your platform, Node version, and reproduction steps.
- **Questions** — open an issue. If it's answered in `docs/`, you'll be pointed there.
- **Fork it** — genuinely. bytelight itself is a fork of [Resonant](https://github.com/codependentai/resonant) and pulls selectively from sibling forks (see `NOTICE`). Taking this code and making it yours is the intended lifecycle. Apache 2.0 — keep the `LICENSE` and `NOTICE` files intact in derivatives.

## What's not

- **Feature PRs without a prior issue** — this repo tracks one deployment's needs. Unsolicited features will usually be declined regardless of quality; open an issue first.
- **Cloud/multi-tenant variants** — bytelight is self-hosted and single-user by design. That constraint is load-bearing.

## Ground rules for ported code

Code cherry-picked from sibling forks is copied whole, license-checked, attributed in `NOTICE` and/or inline, and identity-scrubbed before it lands. If you fork bytelight, extend the same courtesy.
