const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 8766;
const DUEL_MAP_ID = "aim-training-ground";
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Aim Built Duel Server running\n");
});
const wss = new WebSocket.Server({ server });

const duelQueue = [];
const duelRooms = new Map();
const playerToRoom = new Map();
const playerToWaiting = new Set();
const playerSockets = new Map();

function isOpen(ws) {
  return ws && ws.readyState === WebSocket.OPEN;
}

function sendJson(ws, payload) {
  if (!isOpen(ws)) {
    return false;
  }

  ws.send(JSON.stringify(payload));
  return true;
}

function createRoomId() {
  return `duel_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function getPlayerId(ws, msg = {}) {
  if (ws.duelPlayerId) {
    return ws.duelPlayerId;
  }

  const supplied = msg && msg.playerId ? String(msg.playerId).trim() : "";
  ws.duelPlayerId = supplied || `duel_conn_${Math.random().toString(36).slice(2, 10)}`;
  return ws.duelPlayerId;
}

function cleanQueue() {
  for (let i = duelQueue.length - 1; i >= 0; i--) {
    const item = duelQueue[i];
    if (!item || !isOpen(item.ws)) {
      if (item?.playerId) {
        playerToWaiting.delete(item.playerId);
      }
      duelQueue.splice(i, 1);
    }
  }
}

function removeFromQueue(playerId) {
  for (let i = duelQueue.length - 1; i >= 0; i--) {
    if (duelQueue[i]?.playerId === playerId) {
      duelQueue.splice(i, 1);
    }
  }

  playerToWaiting.delete(playerId);
}

function getOpponent(room, playerId) {
  return room?.players?.find((id) => id !== playerId) || null;
}

function cleanupPlayer(playerId, reason = "left") {
  removeFromQueue(playerId);

  const roomId = playerToRoom.get(playerId);
  if (!roomId) {
    return;
  }

  const room = duelRooms.get(roomId);
  if (room) {
    const opponentId = getOpponent(room, playerId);
    const opponentWs = opponentId ? playerSockets.get(opponentId) : null;

    if (opponentWs && isOpen(opponentWs)) {
      sendJson(opponentWs, {
        type: "duel_opponent_left",
        roomId,
        reason
      });
    }

    for (const pid of room.players) {
      playerToRoom.delete(pid);
      playerToWaiting.delete(pid);
    }

    duelRooms.delete(roomId);
  }

  console.log("[DUEL SERVER] cleanup", { playerId, roomId, reason });
}

function handleDuelFind(ws, msg) {
  const playerId = getPlayerId(ws, msg);
  playerSockets.set(playerId, ws);

  console.log("[DUEL SERVER] duel_find", { playerId });

  if (playerToRoom.has(playerId)) {
    sendJson(ws, {
      type: "duel_error",
      reason: "already_in_duel",
      roomId: playerToRoom.get(playerId)
    });
    return;
  }

  if (playerToWaiting.has(playerId)) {
    sendJson(ws, { type: "duel_waiting" });
    return;
  }

  cleanQueue();

  const opponent = duelQueue.shift();
  if (!opponent || !isOpen(opponent.ws)) {
    duelQueue.push({
      playerId,
      ws,
      queuedAt: Date.now()
    });
    playerToWaiting.add(playerId);

    sendJson(ws, { type: "duel_waiting" });

    console.log("[DUEL SERVER] queued", {
      playerId,
      queueLength: duelQueue.length
    });
    return;
  }

  playerToWaiting.delete(opponent.playerId);
  playerToWaiting.delete(playerId);

  const roomId = createRoomId();
  const room = {
    roomId,
    mapId: DUEL_MAP_ID,
    players: [opponent.playerId, playerId],
    createdAt: Date.now(),
    state: "active"
  };

  duelRooms.set(roomId, room);
  playerToRoom.set(opponent.playerId, roomId);
  playerToRoom.set(playerId, roomId);

  sendJson(opponent.ws, {
    type: "duel_start",
    roomId,
    mapId: DUEL_MAP_ID,
    opponentId: playerId,
    spawnIndex: 0
  });

  sendJson(ws, {
    type: "duel_start",
    roomId,
    mapId: DUEL_MAP_ID,
    opponentId: opponent.playerId,
    spawnIndex: 1
  });

  console.log("[DUEL SERVER] room created", {
    roomId,
    players: room.players,
    mapId: DUEL_MAP_ID
  });
}

function routePlayerState(ws, msg) {
  const playerId = getPlayerId(ws, msg);
  playerSockets.set(playerId, ws);

  const roomId = playerToRoom.get(playerId);
  if (!roomId) {
    return;
  }

  const room = duelRooms.get(roomId);
  if (!room) {
    return;
  }

  const opponentId = getOpponent(room, playerId);
  const opponentWs = opponentId ? playerSockets.get(opponentId) : null;

  if (opponentWs && isOpen(opponentWs)) {
    sendJson(opponentWs, {
      ...msg,
      type: "player_state",
      roomId,
      duelRoomId: roomId,
      fromPlayerId: playerId
    });
  }
}

wss.on("connection", (ws) => {
  console.log("[DUEL SERVER] connection opened");

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (error) {
      sendJson(ws, {
        type: "duel_error",
        reason: "bad_json"
      });
      return;
    }

    if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
      sendJson(ws, {
        type: "duel_error",
        reason: "bad_payload"
      });
      return;
    }

    if (msg.type === "duel_find") {
      handleDuelFind(ws, msg);
      return;
    }

    if (msg.type === "duel_cancel") {
      const playerId = getPlayerId(ws, msg);
      removeFromQueue(playerId);
      sendJson(ws, { type: "duel_cancelled" });
      return;
    }

    if (msg.type === "player_state") {
      routePlayerState(ws, msg);
      return;
    }

    if (msg.type === "duel_debug_state") {
      const playerId = getPlayerId(ws, msg);
      sendJson(ws, {
        type: "duel_debug_state_result",
        playerId,
        queueLength: duelQueue.length,
        roomCount: duelRooms.size,
        isWaiting: playerToWaiting.has(playerId),
        roomId: playerToRoom.get(playerId) || null
      });
      return;
    }

    sendJson(ws, {
      type: "duel_error",
      reason: "unknown_message_type",
      receivedType: msg.type
    });
  });

  ws.on("close", () => {
    const playerId = ws.duelPlayerId || null;
    if (playerId) {
      cleanupPlayer(playerId, "disconnect");
      playerSockets.delete(playerId);
    }
  });

  ws.on("error", () => {
    const playerId = ws.duelPlayerId || null;
    if (playerId) {
      cleanupPlayer(playerId, "socket_error");
      playerSockets.delete(playerId);
    }
  });
});

server.listen(PORT, () => {
  console.log("[DUEL SERVER] listening on port", PORT);
});
