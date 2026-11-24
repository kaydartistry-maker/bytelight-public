local WidgetContainer = require("ui/widget/container/widgetcontainer")
local UIManager = require("ui/uimanager")
local InputDialog = require("ui/widget/inputdialog")
local InfoMessage = require("ui/widget/infomessage")
local ConfirmBox = require("ui/widget/confirmbox")
local LuaSettings = require("luasettings")
local DataStorage = require("datastorage")
local Screen = require("device").screen
local rapidjson = require("rapidjson")
local https = require("ssl.https")
local ltn12 = require("ltn12")
local logger = require("logger")

local BookBridge = WidgetContainer:extend { name = "bytelightbookbridge", is_doc_only = true }
local settings_path = DataStorage:getSettingsDir() .. "/bytelight-book-bridge.lua"
local plugin_dir = (debug.getinfo(1, "S").source or ""):match("^@(.+)/[^/]+$") or "."
local function trim(s) return (tostring(s or ""):gsub("^%s+", ""):gsub("%s+$", "")) end
local function slashless(s) return trim(s):gsub("/+$", "") end
local function folded(s) return trim(s):gsub("%s+", " ") end
local function now_id() return tostring(os.time()) .. "-" .. tostring(math.random(100000, 999999)) end

function BookBridge:init()
    self.settings = LuaSettings:open(settings_path)
    self.pending = self.settings:readSetting("pending") or {}
    self.notes = self.settings:readSetting("notes") or {}
    self.book_ids = self.settings:readSetting("book_ids") or {}
    self.flush_scheduled = false
    self.ui.menu:registerToMainMenu(self)
end

function BookBridge:save()
    self.settings:saveSetting("pending", self.pending)
    self.settings:saveSetting("notes", self.notes)
    self.settings:saveSetting("book_ids", self.book_ids)
    self.settings:flush()
end

function BookBridge:configured()
    return trim(self.settings:readSetting("server")) ~= "" and trim(self.settings:readSetting("token")) ~= ""
end

function BookBridge:request(method, path, body, with_token)
    local server = slashless(self.settings:readSetting("server"))
    if not server:match("^https://") then return nil, "The server must use HTTPS." end
    local chunks, headers = {}, { ["Accept"] = "application/json" }
    local payload = body and rapidjson.encode(body) or nil
    if payload then headers["Content-Type"], headers["Content-Length"] = "application/json", tostring(#payload) end
    if with_token then headers["Authorization"] = "Bearer " .. trim(self.settings:readSetting("token")) end
    local _, code = https.request {
        url = server .. path, method = method, headers = headers,
        source = payload and ltn12.source.string(payload) or nil,
        sink = ltn12.sink.table(chunks), protocol = "tlsv1_2",
        -- KOReader's LuaSec cannot consume Android's hashed CA directory on
        -- every BOOX build.  Keep verification on and ship only the public
        -- ISRG root that authenticates the app's Let's Encrypt chain.
        verify = "peer", options = { "all", "no_sslv2", "no_sslv3" },
        cafile = plugin_dir .. "/isrg-root-x2.pem",
    }
    local raw = table.concat(chunks)
    local ok, decoded = pcall(rapidjson.decode, raw ~= "" and raw or "{}")
    if tonumber(code) and tonumber(code) >= 200 and tonumber(code) < 300 and ok then return decoded end
    return nil, (ok and decoded and decoded.error) or ("Book Bridge answered " .. tostring(code))
end

function BookBridge:pair(server, code)
    self.settings:saveSetting("server", slashless(server))
    self.settings:flush()
    local reply, err = self:request("POST", "/api/book-bridge/claim", { code = trim(code):gsub("%-", "") }, false)
    if not reply or not reply.token then return nil, err end
    self.settings:saveSetting("token", reply.token)
    self.settings:flush()
    return true
end

function BookBridge:showPairCode(server)
    local dialog
    dialog = InputDialog:new {
        title = "One-time pairing code", input = "", input_hint = "ABCD-EFGH",
        buttons = {{
            { text = "Cancel", callback = function() UIManager:close(dialog) end },
            { text = "Pair", is_enter_default = true, callback = function()
                local code = dialog:getInputText(); UIManager:close(dialog)
                local ok, err = self:pair(server, code)
                UIManager:show(InfoMessage:new { text = ok and "ByteLight is paired. You won't enter this again." or ("Pairing failed: " .. tostring(err)) })
            end },
        }},
    }
    UIManager:show(dialog)
end

function BookBridge:showSetup()
    local dialog
    dialog = InputDialog:new {
        title = "ByteLight server", input = self.settings:readSetting("server") or "https://",
        input_hint = "https://your-bytelight-address",
        buttons = {{
            { text = "Cancel", callback = function() UIManager:close(dialog) end },
            { text = "Next", is_enter_default = true, callback = function()
                local server = dialog:getInputText(); UIManager:close(dialog); self:showPairCode(server)
            end },
        }},
    }
    UIManager:show(dialog)
end

function BookBridge:disconnect()
    self.settings:delSetting("token"); self.settings:flush()
    UIManager:show(InfoMessage:new { text = "This BOOX forgot its ByteLight pairing." })
end

function BookBridge:addToMainMenu(menu_items)
    menu_items.bytelight_book_bridge = {
        text = "ByteLight Book Bridge",
        -- User plugins are not assigned to a tab automatically on every
        -- KOReader build.  Without this hint the plugin can be enabled and
        -- loaded while remaining absent from the visible Tools menu.
        sorting_hint = "tools",
        sub_item_table = {
            { text = self:configured() and "Paired" or "Pair this BOOX", enabled_func = function() return not self:configured() end, callback = function() self:showSetup() end },
            { text = "Send this page now", enabled_func = function() return self:configured() end, callback = function() self:queuePage(true) end },
            { text = "Forget pairing", enabled_func = function() return self:configured() end, callback = function()
                UIManager:show(ConfirmBox:new { text = "Forget this BOOX pairing?", ok_text = "Forget", ok_callback = function() self:disconnect() end })
            end },
        },
    }
end

function BookBridge:bookTitle()
    local props = self.ui.document and self.ui.document:getProps() or {}
    return trim(props.title) ~= "" and props.title or trim(self.ui.document and self.ui.document.file)
end

function BookBridge:visibleText()
    local doc = self.ui.document
    if not doc or not doc.getTextFromPositions then return "" end
    local ok, result = pcall(doc.getTextFromPositions, doc, { x = 0, y = 0 }, { x = Screen:getWidth(), y = Screen:getHeight() }, true)
    if not ok then return "" end
    if type(result) == "table" then return trim(result.text or result[1] or "") end
    return trim(result)
end

function BookBridge:progress()
    local ok, value = pcall(self.ui.getLastProgress, self.ui)
    if ok and tonumber(value) then return math.max(0, math.min(1, tonumber(value))) end
    local page = tonumber(self.ui.document and self.ui.document:getCurrentPage()) or 1
    local pages = tonumber(self.ui.document and self.ui.document:getPageCount()) or 1
    return math.max(0, math.min(1, page / math.max(1, pages)))
end

function BookBridge:queuePage(immediate)
    if not self:configured() or not self.ui.document then return end
    local title, text = self:bookTitle(), self:visibleText()
    if title == "" then return end
    local update = {
        eventId = now_id(), book = { title = title, id = self.book_ids[title] },
        position = { overallFraction = self:progress() },
        viewport = { text = text, anchor = text:sub(1, 800) },
        occurredAt = os.date("!%Y-%m-%dT%H:%M:%SZ"),
    }
    -- Only the newest unsent viewport matters; replacing it prevents rapid
    -- redraw events from filling the offline queue.
    if #self.pending > 0 and self.pending[#self.pending].book.title == title then
        self.pending[#self.pending] = update
    else
        self.pending[#self.pending + 1] = update
    end
    while #self.pending > 40 do table.remove(self.pending, 1) end
    self:save()
    if immediate then self:flush() else self:scheduleFlush() end
end

function BookBridge:scheduleFlush()
    if self.flush_scheduled then return end
    self.flush_scheduled = true
    UIManager:scheduleIn(1.5, function() self.flush_scheduled = false; self:flush() end)
end

function BookBridge:deliverVisibleNotes(visible)
    if visible == "" then return end
    local page = folded(visible)
    local shown = {}
    for i = #self.notes, 1, -1 do
        local note = self.notes[i]
        if note.quote and page:find(folded(note.quote), 1, true) then
            UIManager:show(InfoMessage:new { text = tostring(note.author or "Companion") .. ":\n\n“" .. note.quote .. "”\n\n" .. tostring(note.note or "") })
            shown[#shown + 1] = note.id; table.remove(self.notes, i)
        end
    end
    if #shown > 0 then self:request("POST", "/api/book-bridge/outbox/ack", { ids = shown }, true); self:save() end
end

function BookBridge:flush()
    if #self.pending == 0 then self:deliverVisibleNotes(self:visibleText()); return end
    local item = self.pending[1]
    local reply, err = self:request("POST", "/api/book-bridge/events", item, true)
    if not reply then logger.warn("Book Bridge kept page in its offline queue: " .. tostring(err)); return end
    table.remove(self.pending, 1)
    if reply.bookId then self.book_ids[item.book.title] = reply.bookId end
    for _, note in ipairs(reply.pending or {}) do
        local seen = false
        for _, held in ipairs(self.notes) do if held.id == note.id then seen = true end end
        if not seen then self.notes[#self.notes + 1] = note end
    end
    self:save(); self:deliverVisibleNotes(item.viewport.text or "")
    if #self.pending > 0 then self:scheduleFlush() end
end

function BookBridge:onReaderReady() self:queuePage(false) end
function BookBridge:onPageUpdate() self:queuePage(false) end
function BookBridge:onPosUpdate() self:queuePage(false) end
function BookBridge:onCloseDocument() self:flush(); self:save() end

return BookBridge
