// Décode les entités HTML (&amp;, &#39;, &gt;, &quot;, etc.) présentes dans les
// snippets renvoyés par l'API Gmail. Utilise le parser natif du navigateur.
let decoderEl: HTMLTextAreaElement | null = null

export function decodeHtmlEntities(input: string): string {
  if (!input || input.indexOf('&') === -1) return input
  if (!decoderEl) decoderEl = document.createElement('textarea')
  decoderEl.innerHTML = input
  return decoderEl.value
}
