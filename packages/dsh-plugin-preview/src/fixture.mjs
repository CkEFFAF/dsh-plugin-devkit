/**
 * Fixture snapshots: the fake session data a previewed client half sees.
 *
 * 设计文档 §7 names the input seam as **slot id + fixture snapshot + client
 * factory**. This module owns the middle term.
 *
 * ## Why a fixture rather than a live snapshot
 *
 * A real Conversation Snapshot is live runtime data belonging to a real session.
 * 设计文档 forbids serializing those whole, and a preview has no session anyway —
 * it exists precisely so an author can look at a slot *without* starting a full
 * Agent conversation (功能文档 §6.4, user story 17). So the fixture is plain,
 * owned, losslessly-JSON data shaped like the fields a slot actually receives.
 *
 * ## What is deliberately absent
 *
 * No session ids, no tokens, no workspace paths. A fixture that carried real
 * identifiers would make the preview a place secrets accumulate, which design
 * constraint 3 exists to prevent. Values here are obviously synthetic.
 */

import { serializeForScript } from './shell.mjs'

/**
 * A minimal, honest fixture: enough for a client half to render without a session.
 *
 * @param {{slot?: string, label?: string, messages?: Array<{role: string, text: string}>}} [options]
 * @returns {object} plain JSON
 */
export function createFixture(options = {}) {
  return {
    // Marked synthetic so a screenshot can never be mistaken for a real session.
    fixture: true,
    slot: options.slot ?? 'unknown.slot',
    label: options.label ?? 'preview fixture',
    session: {
      id: 'preview-session',
      title: options.label ?? 'Preview fixture',
      workspace: '(preview workspace)',
    },
    messages: options.messages ?? [
      { role: 'user', text: 'Does this slot render at the right size?' },
      { role: 'assistant', text: 'It renders from a fixture, without a real session.' },
    ],
  }
}

/**
 * The fixture as a string safe to embed in a `<script>` element.
 *
 * Delegates to the shell's serializer so there is exactly one escaping
 * implementation. `JSON.stringify` alone would let a fixture containing
 * `</script>` terminate the host page's script element.
 *
 * @param {object} fixture
 * @returns {string}
 */
export function serializeFixture(fixture) {
  return serializeForScript(fixture ?? {})
}

/**
 * Validate that a value is a usable fixture.
 *
 * @param {unknown} fixture
 * @returns {{ok: boolean, reason: string|null}}
 */
export function validateFixture(fixture) {
  if (fixture === null || typeof fixture !== 'object' || Array.isArray(fixture)) {
    return { ok: false, reason: 'fixture must be a JSON object' }
  }
  if (fixture.messages !== undefined && !Array.isArray(fixture.messages)) {
    return { ok: false, reason: 'fixture.messages must be an array when present' }
  }
  return { ok: true, reason: null }
}
