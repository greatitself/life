/** Read the persisted conversation store used by this application environment. */
function readSavedThreads(page) {
  return page.evaluate(async () => {
    if (window.relay?.conversations?.load) {
      const snapshot = await window.relay.conversations.load()
      return snapshot?.threads || []
    }
    return JSON.parse(localStorage.getItem('relay.threads.v1') || '[]')
  })
}

module.exports = { readSavedThreads }
