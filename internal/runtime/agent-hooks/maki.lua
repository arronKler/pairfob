-- Pairfob session observation: managed file.
if maki.uv.os_getenv("HERDR_ENV") ~= "1" then return end
if not maki.uv.os_getenv("HERDR_PANE_ID") or not maki.uv.os_getenv("HERDR_SOCKET_PATH") then return end

-- Luau's high-resolution monotonic clock survives plugin reloads in this host.
local function tick() return math.floor(os.clock() * 1000000) end
local sequence = tick()
local function report(id, action)
  if type(id) ~= "string" or id == "" then return end
  sequence = math.max(sequence + 1, tick())
  maki.fn.jobstart({ PAIRFOB_BINARY, "agent-hook", "maki", id,
    string.format("%.0f", sequence), action }, { scope = "plugin", stdout = false, stderr = false })
  -- Plugin scope survives this event dispatch. Sequence numbers reject late
  -- reports without waiting for a subprocess on the interactive UI thread.
end
maki.api.create_autocmd("SessionFocusChanged", {
  callback = function(ev) report(ev.data.session_id, "bind") end,
})
maki.api.create_autocmd("TurnStart", {
  callback = function(ev)
    if ev.data.session_id == maki.session.current() then report(ev.data.session_id, "bind") end
  end,
})
maki.api.create_autocmd({ "SessionEnd", "SessionReset" }, {
  callback = function(ev)
    if ev.data.session_id == maki.session.current() then report(ev.data.session_id, "clear") end
  end,
})
