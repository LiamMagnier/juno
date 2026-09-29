# Agents: motion

2026-09-30. How an agent's face moves, and why. The web source of truth is
`src/components/agents/face-rig.ts` (what JavaScript drives) and
`src/components/agents/agent-face.css` (everything else). The Swift face
(`JunoAgentFace.swift`) follows the same table.

## The rule

Motion on Agents means something. The face is the agent's status bar, so every
movement is either presence (it is here and paying attention) or state (what it
is doing). Nothing else on the page loops. Under reduced motion all of it stops
and the eyes' shape alone carries the state.

## Presence (every face, every state that has open eyes)

| Behaviour | Timing | Notes |
| --- | --- | --- |
| Blink | every 2.6 to 6.4 s, 16% double | eyes close to 8% height in 80 ms |
| Glance | every 1.8 to 5.2 s | mostly ahead, sometimes aside, small |
| Look at the pointer | per frame while the pointer moves | reach grows with face size; strength eases off with distance; right on top of the face it looks at you |
| Notice | on hovering the control that holds it | one blink, lifts 1.8 px, eyes widen 10% |
| Press | while pressed | squash to 106% x 92% |
| React | on any change of state | settle from 94% to 104% to 100% |

How much the pointer pulls the eyes depends on the state: waiting 1.15, idle 1,
listening 0.9, done 0.8, blocked 0.5, working 0.35, thinking 0.25, sleeping 0.

## State

| State | Face | Halo (presence) | Words |
| --- | --- | --- | --- |
| idle | breathes (5.6 s) | quiet | plain |
| thinking | looks up and aside, sways (4.4 s), thought dots rise | a slow turning light | slow shine |
| working | narrowed eyes read along lines (2.7 s), small bob with ground shadow, three work marks | breathes (2.7 s) | slow shine |
| waiting | wide eyes that seek you, an "over here" lift and tilt every 3.4 s | full | accent, hand icon |
| done | happy arcs, one hop with squash on landing | quiet | plain |
| blocked | flat eyes, tilted | quiet | accent, hand icon |
| sleeping (paused) | closed eyes, slow breath | dim | plain |
| listening (voice) | pupils follow the caller's level | quiet | plain |

On the Agents home, a working or thinking agent's card also carries a slow
light along its lower edge in the agent's tone.

## Drawing

Shaded body (radial light from the upper left, the tone, a deeper rim),
catchlights in the eyes and a ground shadow from 40 px up; marks and the
thinking/working details from 28 px up; eyes always.
