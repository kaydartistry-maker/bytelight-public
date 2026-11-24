---
name: using-bytelight-studio
description: Create companion selfies, User artwork, scene pictures, and Spellbook renders through ByteLight's native Studio. Use for image requests inside ByteLight. Prefer the house image and Spellbook commands, use saved reference drawers for recurring people, and never claim an image appeared before the command confirms it was accepted.
---

# ByteLight Studio

ByteLight's Studio is the native image route. It posts completed pictures into the current conversation and can preserve recurring likenesses through reference drawers.

## Direct pictures

Run the house command from the active ByteLight source directory:

`node tools/sc.mjs image "<concise visual prompt>"`

For recurring people, add only the drawers actually needed:

`--subjects companion-a`

`--subjects companion-a,companion-b,user`

Use `--size portrait` or `--size landscape` when framing matters. For a one-time reference supplied in the current chat, use `--use-dropped` rather than saving it as a recurring identity.

The current drawers are described in the turn orientation. Never name an empty drawer and pretend it contains a reference.

The command returns before rendering finishes. Say the picture is on the way; do not say it is already visible.

## Spellbook

Use the house Spellbook commands when User asks to find, surprise-cast, reuse, or reinterpret a saved scene:

- `node tools/sc.mjs spellbook search "<query>"`
- `node tools/sc.mjs spellbook surprise --filter unmade`
- `node tools/sc.mjs spellbook cast <spell-id> --cast <drawer-list>`
- `node tools/sc.mjs spellbook read --cast <drawer-list>` for a picture she just supplied as a spell

Respect the cast order and any saved look. A cast picture posts into the conversation and pins to the Spellbook wall.

## Rules

- Use the model configured in Studio; do not silently route through an old ChatGPT-app, Letta, raw API, Flux, Gemini, FLORA, or LoRA procedure.
- Use User's canonical subject references rather than reconstructing recurring people from prose alone.
- Keep prompts focused on the requested scene. Do not dump private memory into them.
- If Studio is disabled or a command fails, report the blocker exactly. Never invent a successful render.
- Image editing uses the dropped image or the appropriate saved reference drawer; preserve requested identity, composition, and transparency.
- Experimental Example materials are preserved outside the active registry. They are not the default production route.
