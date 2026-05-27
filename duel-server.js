const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 8766;
const DUEL_MAP_ID = "oneVOneDuel";
const DUEL_MAX_HP = 100;
const DUEL_WIN_SCORE = 10;
const DUEL_RESPAWN_DELAY_MS = 1500;
const DUEL_MAX_DAMAGE_PER_HIT = 250;
const DUEL_TEST_SPAWNS = Object.freeze([
  Object.freeze({ x: -0.0, y: 0.0, z: 23.4, yaw: Math.PI }),
  Object.freeze({ x: -0.0, y: 0.0, z: -23.2, yaw: 0 })
]);
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
  let removed = false;
  for (let i = duelQueue.length - 1; i >= 0; i--) {
    if (duelQueue[i]?.playerId === playerId) {
      duelQueue.splice(i, 1);
      removed = true;
    }
  }

  if (playerToWaiting.delete(playerId)) {
    removed = true;
  }

  if (removed) {
    console.log("[DUEL SERVER] duel queue remove", {
      playerId,
      queueLength: duelQueue.length
    });
  }

  return removed;
}

function getOpponent(room, playerId) {
  return room?.players?.find((id) => id !== playerId) || null;
}

function getDuelSpawnForIndex(spawnIndex) {
  const index = spawnIndex === 1 ? 1 : 0;
  return {
    ...DUEL_TEST_SPAWNS[index],
    spawnIndex: index
  };
}

function getDuelTeamForSpawnIndex(spawnIndex) {
  const spawn = getDuelSpawnForIndex(spawnIndex);
  return Number(spawn.z) < 0 ? "blue" : "orange";
}

function buildSpawnByPlayerId(room) {
  const spawnByPlayerId = {};
  if (!room?.players?.length) {
    return spawnByPlayerId;
  }

  room.players.forEach((playerId, index) => {
    spawnByPlayerId[playerId] = getDuelSpawnForIndex(index === 1 ? 1 : 0);
  });

  return spawnByPlayerId;
}

function buildTeamByPlayerId(room) {
  const teamByPlayerId = {};
  if (!room?.players?.length) {
    return teamByPlayerId;
  }

  room.players.forEach((playerId, index) => {
    teamByPlayerId[playerId] = getDuelTeamForSpawnIndex(index === 1 ? 1 : 0);
  });

  return teamByPlayerId;
}

function getScoreByTeam(room) {
  return {
    blue: Number(room?.scoreByTeam?.blue) || 0,
    orange: Number(room?.scoreByTeam?.orange) || 0
  };
}

function getScoreBySpawnIndex(room) {
  return {
    0: Number(room?.scoreByPlayerId?.[room?.players?.[0]]) || 0,
    1: Number(room?.scoreByPlayerId?.[room?.players?.[1]]) || 0
  };
}

function broadcastToDuelRoom(room, payload) {
  if (!room?.players?.length) {
    return;
  }

  for (const pid of room.players) {
    const ws = playerSockets.get(pid);
    if (ws && isOpen(ws)) {
      sendJson(ws, payload);
    }
  }
}

function sendToDuelOpponent(room, playerId, payload) {
  const opponentId = getOpponent(room, playerId);
  const opponentWs = opponentId ? playerSockets.get(opponentId) : null;
  if (!opponentWs || !isOpen(opponentWs)) {
    return false;
  }

  return sendJson(opponentWs, payload);
}

function leaveDuelSession(playerId, reason = "leave") {
  if (!playerId) {
    return false;
  }

  const wasQueued = removeFromQueue(playerId);

  const roomId = playerToRoom.get(playerId);
  if (!roomId) {
    return wasQueued;
  }

  const room = duelRooms.get(roomId);
  if (room) {
    if (room.roundResetTimeoutId) {
      clearTimeout(room.roundResetTimeoutId);
      room.roundResetTimeoutId = 0;
    }

    const opponentId = getOpponent(room, playerId);
    const opponentWs = opponentId ? playerSockets.get(opponentId) : null;

    if (opponentWs && isOpen(opponentWs)) {
      sendJson(opponentWs, {
        type: "duel_opponent_left",
        roomId,
        playerId,
        reason,
        timestamp: Date.now()
      });
    }

    for (const pid of room.players) {
      playerToRoom.delete(pid);
      playerToWaiting.delete(pid);
    }

    duelRooms.delete(roomId);

    console.log("[DUEL SERVER] duel cleanup room closed", {
      playerId,
      opponentId,
      roomId,
      reason
    });
  }

  console.log("[DUEL SERVER] cleanup", { playerId, roomId, reason });
  return true;
}

function cleanupPlayer(playerId, reason = "left") {
  return leaveDuelSession(playerId, reason);
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
    state: "active",
    matchVersion: 1,
    roundVersion: 1,
    roundLocked: false,
    matchLocked: false,
    matchOver: false,
    winnerTeam: null,
    loserTeam: null,
    winnerPlayerId: null,
    loserPlayerId: null,
    healthByPlayerId: {
      [opponent.playerId]: DUEL_MAX_HP,
      [playerId]: DUEL_MAX_HP
    },
    maxHpByPlayerId: {
      [opponent.playerId]: DUEL_MAX_HP,
      [playerId]: DUEL_MAX_HP
    },
    scoreByPlayerId: {
      [opponent.playerId]: 0,
      [playerId]: 0
    },
    teamByPlayerId: {},
    scoreByTeam: {
      blue: 0,
      orange: 0
    },
    processedHitIds: new Set(),
    roundResetTimeoutId: 0
  };
  room.teamByPlayerId = buildTeamByPlayerId(room);

  duelRooms.set(roomId, room);
  playerToRoom.set(opponent.playerId, roomId);
  playerToRoom.set(playerId, roomId);

  sendJson(opponent.ws, {
    type: "duel_start",
    roomId,
    mapId: DUEL_MAP_ID,
    opponentId: playerId,
    spawnIndex: 0,
    localHp: DUEL_MAX_HP,
    opponentHp: DUEL_MAX_HP,
    maxHp: DUEL_MAX_HP,
    winningScore: DUEL_WIN_SCORE,
    roundVersion: room.roundVersion,
    spawns: DUEL_TEST_SPAWNS.map((spawn) => ({ ...spawn })),
    spawnByPlayerId: buildSpawnByPlayerId(room),
    teamByPlayerId: { ...room.teamByPlayerId },
    scoreByPlayerId: { ...room.scoreByPlayerId },
    scoreByTeam: getScoreByTeam(room),
    scoreBySpawnIndex: getScoreBySpawnIndex(room)
  });

  sendJson(ws, {
    type: "duel_start",
    roomId,
    mapId: DUEL_MAP_ID,
    opponentId: opponent.playerId,
    spawnIndex: 1,
    localHp: DUEL_MAX_HP,
    opponentHp: DUEL_MAX_HP,
    maxHp: DUEL_MAX_HP,
    winningScore: DUEL_WIN_SCORE,
    roundVersion: room.roundVersion,
    spawns: DUEL_TEST_SPAWNS.map((spawn) => ({ ...spawn })),
    spawnByPlayerId: buildSpawnByPlayerId(room),
    teamByPlayerId: { ...room.teamByPlayerId },
    scoreByPlayerId: { ...room.scoreByPlayerId },
    scoreByTeam: getScoreByTeam(room),
    scoreBySpawnIndex: getScoreBySpawnIndex(room)
  });

  console.log("[DUEL SERVER] room created", {
    roomId,
    players: room.players,
    mapId: DUEL_MAP_ID
  });
}

function handleDuelPlayerDown(room, attackerId, victimId) {
  if (!room || room.roundLocked || room.matchLocked || room.matchOver) {
    return;
  }

  room.roundLocked = true;
  if (!room.teamByPlayerId || !room.teamByPlayerId[attackerId]) {
    room.teamByPlayerId = buildTeamByPlayerId(room);
  }
  room.scoreByPlayerId = room.scoreByPlayerId || {};
  room.scoreByTeam = room.scoreByTeam || { blue: 0, orange: 0 };
  const scorerTeam = room.teamByPlayerId[attackerId] || "blue";
  room.scoreByPlayerId[attackerId] = (Number(room.scoreByPlayerId[attackerId]) || 0) + 1;
  room.scoreByTeam[scorerTeam] = (Number(room.scoreByTeam[scorerTeam]) || 0) + 1;

  const scoreByPlayerId = { ...room.scoreByPlayerId };
  const scoreByTeam = getScoreByTeam(room);
  const scoreBySpawnIndex = getScoreBySpawnIndex(room);

  console.log("[DUEL SERVER] duel player down", {
    roomId: room.roomId,
    attackerId,
    victimId,
    roundVersion: room.roundVersion,
    scorerTeam,
    scoreByTeam,
    scoreBySpawnIndex
  });

  broadcastToDuelRoom(room, {
    type: "duel_score_update",
    roomId: room.roomId,
    roundVersion: room.roundVersion,
    scorerId: attackerId,
    victimId,
    scorerTeam,
    scoreByTeam,
    teamByPlayerId: { ...room.teamByPlayerId },
    scoreByPlayerId,
    scoreBySpawnIndex,
    timestamp: Date.now()
  });

  if (scoreByTeam[scorerTeam] >= DUEL_WIN_SCORE) {
    const loserTeam = room.teamByPlayerId[victimId] || (scorerTeam === "blue" ? "orange" : "blue");
    room.matchLocked = true;
    room.matchOver = true;
    room.roundLocked = true;
    room.winnerTeam = scorerTeam;
    room.loserTeam = loserTeam;
    room.winnerPlayerId = attackerId;
    room.loserPlayerId = victimId;

    console.log("[DUEL MATCH END] match over", {
      roomId: room.roomId,
      roundVersion: room.roundVersion,
      winnerTeam: room.winnerTeam,
      loserTeam: room.loserTeam,
      winnerPlayerId: room.winnerPlayerId,
      loserPlayerId: room.loserPlayerId,
      scoreByTeam
    });

    broadcastToDuelRoom(room, {
      type: "duel_match_over",
      roomId: room.roomId,
      roundVersion: room.roundVersion,
      matchVersion: room.matchVersion,
      winnerTeam: room.winnerTeam,
      loserTeam: room.loserTeam,
      winnerPlayerId: room.winnerPlayerId,
      loserPlayerId: room.loserPlayerId,
      scoreByTeam,
      teamByPlayerId: { ...room.teamByPlayerId },
      scoreByPlayerId,
      scoreBySpawnIndex,
      winningScore: DUEL_WIN_SCORE,
      timestamp: Date.now()
    });
    return;
  }

  broadcastToDuelRoom(room, {
    type: "duel_player_down",
    roomId: room.roomId,
    roundVersion: room.roundVersion,
    victimId,
    attackerId,
    scorerTeam,
    scoreByTeam,
    teamByPlayerId: { ...room.teamByPlayerId },
    scoreByPlayerId,
    scoreBySpawnIndex,
    respawnDelayMs: DUEL_RESPAWN_DELAY_MS,
    timestamp: Date.now()
  });

  room.roundResetTimeoutId = setTimeout(() => {
    const liveRoom = duelRooms.get(room.roomId);
    if (!liveRoom) {
      return;
    }

    liveRoom.roundResetTimeoutId = 0;

    for (const pid of liveRoom.players) {
      liveRoom.healthByPlayerId[pid] = DUEL_MAX_HP;
      liveRoom.maxHpByPlayerId[pid] = DUEL_MAX_HP;
    }

    liveRoom.roundVersion += 1;
    liveRoom.roundLocked = false;
    liveRoom.processedHitIds.clear();

    console.log("[DUEL SERVER] duel round reset", {
      roomId: liveRoom.roomId,
      roundVersion: liveRoom.roundVersion
    });

    broadcastToDuelRoom(liveRoom, {
      type: "duel_round_reset",
      roomId: liveRoom.roomId,
      roundVersion: liveRoom.roundVersion,
      hpByPlayerId: { ...liveRoom.healthByPlayerId },
      maxHp: DUEL_MAX_HP,
      spawns: DUEL_TEST_SPAWNS.map((spawn) => ({ ...spawn })),
      spawnByPlayerId: buildSpawnByPlayerId(liveRoom),
      teamByPlayerId: { ...(liveRoom.teamByPlayerId || buildTeamByPlayerId(liveRoom)) },
      scoreByPlayerId: { ...liveRoom.scoreByPlayerId },
      scoreByTeam: getScoreByTeam(liveRoom),
      scoreBySpawnIndex: getScoreBySpawnIndex(liveRoom),
      timestamp: Date.now()
    });
  }, DUEL_RESPAWN_DELAY_MS);
}

function handleDuelRematch(ws, msg) {
  const playerId = getPlayerId(ws, msg);
  playerSockets.set(playerId, ws);

  const roomId = playerToRoom.get(playerId);
  const room = roomId ? duelRooms.get(roomId) : null;
  if (!room) {
    sendJson(ws, { type: "duel_error", reason: "not_in_duel" });
    return;
  }

  if (msg.roomId && msg.roomId !== roomId) {
    sendJson(ws, { type: "duel_error", reason: "wrong_room" });
    return;
  }

  if (room.roundResetTimeoutId) {
    clearTimeout(room.roundResetTimeoutId);
    room.roundResetTimeoutId = 0;
  }

  room.matchVersion = (Number(room.matchVersion) || 1) + 1;
  room.roundVersion = (Number(room.roundVersion) || 1) + 1;
  room.roundLocked = false;
  room.matchLocked = false;
  room.matchOver = false;
  room.winnerTeam = null;
  room.loserTeam = null;
  room.winnerPlayerId = null;
  room.loserPlayerId = null;
  room.teamByPlayerId = buildTeamByPlayerId(room);
  room.scoreByPlayerId = {};
  room.scoreByTeam = { blue: 0, orange: 0 };
  room.healthByPlayerId = {};
  room.maxHpByPlayerId = {};

  for (const pid of room.players) {
    room.scoreByPlayerId[pid] = 0;
    room.healthByPlayerId[pid] = DUEL_MAX_HP;
    room.maxHpByPlayerId[pid] = DUEL_MAX_HP;
  }

  if (room.processedHitIds && typeof room.processedHitIds.clear === "function") {
    room.processedHitIds.clear();
  } else {
    room.processedHitIds = new Set();
  }

  const payload = {
    type: "duel_match_restart",
    roomId,
    roundVersion: room.roundVersion,
    matchVersion: room.matchVersion,
    scoreByTeam: getScoreByTeam(room),
    teamByPlayerId: { ...room.teamByPlayerId },
    hpByPlayerId: { ...room.healthByPlayerId },
    maxHp: DUEL_MAX_HP,
    spawns: DUEL_TEST_SPAWNS.map((spawn) => ({ ...spawn })),
    spawnByPlayerId: buildSpawnByPlayerId(room),
    scoreByPlayerId: { ...room.scoreByPlayerId },
    scoreBySpawnIndex: getScoreBySpawnIndex(room),
    winningScore: DUEL_WIN_SCORE,
    timestamp: Date.now()
  };

  console.log("[DUEL MATCH END] match restart requested", {
    roomId,
    playerId,
    reason: msg.reason || "button",
    roundVersion: room.roundVersion,
    matchVersion: room.matchVersion
  });

  broadcastToDuelRoom(room, payload);
}

function handleDuelHit(ws, msg) {
  const attackerId = getPlayerId(ws, msg);
  playerSockets.set(attackerId, ws);

  const roomId = playerToRoom.get(attackerId);
  const room = roomId ? duelRooms.get(roomId) : null;
  if (!room) {
    sendJson(ws, { type: "duel_error", reason: "not_in_duel" });
    return;
  }

  if (msg.roomId && msg.roomId !== roomId) {
    sendJson(ws, { type: "duel_error", reason: "wrong_room" });
    return;
  }

  if (room.roundLocked || room.matchLocked || room.matchOver) {
    return;
  }

  const targetPlayerId = String(msg.targetPlayerId || "");
  const opponentId = getOpponent(room, attackerId);
  if (!opponentId || targetPlayerId !== opponentId) {
    sendJson(ws, { type: "duel_error", reason: "invalid_duel_target" });
    return;
  }

  const hitId = String(msg.hitId || "");
  if (!hitId || room.processedHitIds.has(hitId)) {
    return;
  }

  const maxHp = room.maxHpByPlayerId[targetPlayerId] || DUEL_MAX_HP;
  const oldHp = Number(room.healthByPlayerId[targetPlayerId] ?? maxHp);
  if (oldHp <= 0) {
    return;
  }

  const rawAmount = Number(msg.amount);
  const amount = Math.max(
    0,
    Math.min(DUEL_MAX_DAMAGE_PER_HIT, Number.isFinite(rawAmount) ? rawAmount : 0)
  );
  if (amount <= 0) {
    return;
  }

  room.processedHitIds.add(hitId);
  if (room.processedHitIds.size > 300) {
    const firstHitId = room.processedHitIds.values().next().value;
    room.processedHitIds.delete(firstHitId);
  }

  const hp = Math.max(0, oldHp - amount);
  room.healthByPlayerId[targetPlayerId] = hp;

  console.log("[DUEL SERVER] duel_hit applied", {
    roomId,
    attackerId,
    targetPlayerId,
    amount,
    hitZone: String(msg.hitZone || "body"),
    hp,
    roundVersion: room.roundVersion
  });

  broadcastToDuelRoom(room, {
    type: "duel_health_update",
    roomId,
    roundVersion: room.roundVersion,
    attackerId,
    targetPlayerId,
    amount,
    hitZone: String(msg.hitZone || "body"),
    hp,
    maxHp,
    isDead: hp <= 0,
    hitId,
    shotId: String(msg.shotId || ""),
    timestamp: Date.now()
  });

  if (hp <= 0) {
    handleDuelPlayerDown(room, attackerId, targetPlayerId);
  }
}

function relayDuelShot(ws, msg) {
  const playerId = getPlayerId(ws, msg);
  playerSockets.set(playerId, ws);

  const roomId = playerToRoom.get(playerId);
  const room = roomId ? duelRooms.get(roomId) : null;
  if (!room) {
    sendJson(ws, { type: "duel_error", reason: "not_in_duel" });
    return;
  }

  if (msg.roomId && msg.roomId !== roomId) {
    sendJson(ws, { type: "duel_error", reason: "wrong_room" });
    return;
  }

  sendToDuelOpponent(room, playerId, {
    type: "duel_shot",
    roomId,
    fromPlayerId: playerId,
    shot: msg.shot && typeof msg.shot === "object" && !Array.isArray(msg.shot)
      ? msg.shot
      : null,
    timestamp: Date.now()
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

    if (msg.type === "duel_leave") {
      const playerId = getPlayerId(ws, msg);
      console.log("[DUEL SERVER] duel_leave", {
        playerId,
        roomId: msg.roomId || playerToRoom.get(playerId) || null,
        reason: msg.reason || "leave"
      });
      leaveDuelSession(playerId, String(msg.reason || "leave"));
      sendJson(ws, {
        type: "duel_left",
        roomId: msg.roomId || null,
        reason: String(msg.reason || "leave"),
        timestamp: Date.now()
      });
      return;
    }

    if (msg.type === "player_state") {
      routePlayerState(ws, msg);
      return;
    }

    if (msg.type === "duel_hit") {
      handleDuelHit(ws, msg);
      return;
    }

    if (msg.type === "duel_rematch") {
      handleDuelRematch(ws, msg);
      return;
    }

    if (msg.type === "duel_shot") {
      relayDuelShot(ws, msg);
      return;
    }

    if (msg.type === "duel_debug_state") {
      const playerId = getPlayerId(ws, msg);
      const roomId = playerToRoom.get(playerId) || null;
      const room = roomId ? duelRooms.get(roomId) : null;
      sendJson(ws, {
        type: "duel_debug_state_result",
        playerId,
        queueLength: duelQueue.length,
        roomCount: duelRooms.size,
        isWaiting: playerToWaiting.has(playerId),
        roomId,
        playerToRoomEntry: playerToRoom.get(playerId) || null,
        isInQueue: playerToWaiting.has(playerId),
        hp: room ? room.healthByPlayerId[playerId] ?? null : null,
        healthByPlayerId: room ? { ...room.healthByPlayerId } : null,
        maxHpByPlayerId: room ? { ...room.maxHpByPlayerId } : null,
        scoreByPlayerId: room ? { ...room.scoreByPlayerId } : null,
        scoreByTeam: room ? getScoreByTeam(room) : null,
        scoreBySpawnIndex: room ? getScoreBySpawnIndex(room) : null,
        DUEL_WIN_SCORE,
        duelWinScore: DUEL_WIN_SCORE,
        spawns: room ? DUEL_TEST_SPAWNS.map((spawn) => ({ ...spawn })) : null,
        spawnByPlayerId: room ? buildSpawnByPlayerId(room) : null,
        teamByPlayerId: room ? { ...(room.teamByPlayerId || buildTeamByPlayerId(room)) } : null,
        matchVersion: room ? room.matchVersion : null,
        roundVersion: room ? room.roundVersion : null,
        roundLocked: room ? room.roundLocked : null,
        matchLocked: room ? room.matchLocked : null,
        matchOver: room ? room.matchOver : null,
        winnerTeam: room ? room.winnerTeam : null,
        loserTeam: room ? room.loserTeam : null,
        winnerPlayerId: room ? room.winnerPlayerId : null,
        loserPlayerId: room ? room.loserPlayerId : null
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
      if (playerSockets.get(playerId) !== ws) {
        return;
      }
      cleanupPlayer(playerId, "disconnect");
      playerSockets.delete(playerId);
    }
  });

  ws.on("error", () => {
    const playerId = ws.duelPlayerId || null;
    if (playerId) {
      if (playerSockets.get(playerId) !== ws) {
        return;
      }
      cleanupPlayer(playerId, "socket_error");
      playerSockets.delete(playerId);
    }
  });
});

server.listen(PORT, () => {
  console.log("[DUEL SERVER] listening on port", PORT);
});
