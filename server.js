const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
app.set('trust proxy', 1);

const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.get('/favicon.ico', (req, res) => res.status(204).end());

let players = {};
let lobbySockets = new Set();
let activeWooHoo = null;
let quizUsed = false;

// Memorija u RAM-u servera (od startovanja servera)
const MAX_LOG_HISTORY = 300;
let actionLogHistory = []; // { message, avatar, timestamp }
let savedPlayerStatsByName = {}; // ključ: normalizovano ime -> { social, fun, drunk, isBirthdayGirl, lastDuelTime }

// Cooldown-ovi vezani za uređaj / IP: ključ -> { woohooUntil, telephoneUntil, duelUntil }
let deviceCooldowns = {};

// Šifra za status slavljenice
const BIRTHDAY_PASSWORD = 'žmuvoližpu';

// Pamćenje poslednjih akcija za detekciju spamovanja (ključ: "senderId-targetId")
let lastActions = {};

// Globalna vremena poslednjeg pokretanja eventa (vidljiva svima)
let globalCooldowns = {
  telephone: 0,
  woohoo: 0
};

const TELEPHONE_COOLDOWN_MS = 30 * 60 * 1000; // 30 minuta
const EVENT_COOLDOWN_MS = 20 * 60 * 1000;      // 20 minuta za WooHoo
const DUEL_COOLDOWN_MS = 15 * 60 * 1000;       // 15 minuta za Izazovi na piće

const chaosPrompts = [
  "KOŠMAJDAN",
  "ČEPUTIĆ",
  "MASPER SOS",
  "ŽIRAFON",
  "KAŠAČKI PUŠALJ",
  "BULJAVI BRATULJ",
  "MALA MOKRAĆICA",
  "TUFAHIJA",
  "DEDA DARVIN",
  "BOOGRAĐANI",
  "500 CIGARETTES 👽",
  "TATULJ",
  "I Love Beer",
  "SUMA SUMARUM",
  "TO TI MOŽDA"
];

const simsPhrases = [
  "Sul Sul",
  "Dag Dag",
  "Kremisch",
  "Chum Cha",
  "Freet Loo",
  "Nooboo",
  "Deg Deb",
  "Whim Wham",
  "Yibs",
  "Zibbs",
  "Sul Sul Bebe",
  "Comn Naps",
  "Moocha",
  "Vadish",
  "Lalo Simoleons",
  "Rett Kew",
  "Booboo",
  "Zing Zing",
  "Plumbob",
  "Glib Glob"
];

// Pitanja za Anin Quizz Time
const quizQuestions = [
  {
    q: "1. Šta Ana pije u Starbucks-u?",
    options: [
      "Frapućino od banane",
      "Mača sa bademovim mlekom i jagodom",
      "Mača sa ovsenim mlekom i hazelnut sugar-free sirupom"
    ],
    correct: 2,
    isVote: false
  },
  {
    q: "2. Koji sport je Ana trenirala?",
    options: [
      "Badminton",
      "Odbojku",
      "Tenis"
    ],
    correct: 2,
    isVote: false
  },
  {
    q: "3. Anin omiljeni bend?",
    options: [
      "The Killers",
      "Afotička Zona",
      "The Strokes"
    ],
    correct: 1,
    isVote: false
  },
  {
    q: "4. Anina omiljena igračka?",
    options: [
      "Žirafon",
      "Marica",
      "Meda"
    ],
    correct: 0,
    isVote: false
  },
  {
    q: "5. Anin omiljeni broj je:",
    options: [
      "3",
      "10",
      "7"
    ],
    correct: 2,
    isVote: false
  },
  {
    q: "6. Ana u dnevnoj sobi ima 7:",
    options: [
      "Parfema",
      "Sveća",
      "Lampi"
    ],
    correct: 2,
    isVote: false
  },
  {
    q: "7. Ko je najmanje odgovora pogodio popije 7:",
    options: [
      "piva",
      "rakija",
      "šamara"
    ],
    correct: -1,
    isVote: true
  }
];

let activeQuiz = null;
let activeTelephoneGame = null;

function getClientIp(socket) {
  const forwarded = socket.handshake && socket.handshake.headers && socket.handshake.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return (socket.handshake && socket.handshake.address) || (socket.conn && socket.conn.remoteAddress) || 'unknown-ip';
}

function getDeviceKey(socket, rawDeviceId = '') {
  const ip = getClientIp(socket);
  const cleanDev = String(rawDeviceId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  if (cleanDev) {
    return `dev:${cleanDev}|ip:${ip}`;
  }
  return `ip:${ip}`;
}

function ensureDeviceCooldownRecord(deviceKey) {
  if (!deviceCooldowns[deviceKey]) {
    deviceCooldowns[deviceKey] = {
      woohooUntil: 0,
      telephoneUntil: 0,
      duelUntil: 0
    };
  }
  return deviceCooldowns[deviceKey];
}

function getDeviceRemainingCooldowns(deviceKey, now = Date.now()) {
  const rec = ensureDeviceCooldownRecord(deviceKey);
  return {
    woohooRemaining: Math.max(0, rec.woohooUntil - now),
    telephoneRemaining: Math.max(0, rec.telephoneUntil - now),
    duelRemaining: Math.max(0, rec.duelUntil - now)
  };
}

function normalizeName(name) {
  return (name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function isNameTakenByActivePlayer(normalizedName, excludeSocketId = null) {
  if (!normalizedName) return false;
  return Object.entries(players).some(([id, p]) => {
    if (excludeSocketId && id === excludeSocketId) return false;
    return normalizeName(p.name) === normalizedName;
  });
}

function findActiveSocketIdByNormalizedName(normalizedName, excludeSocketId = null) {
  if (!normalizedName) return null;
  for (const [id, p] of Object.entries(players)) {
    if (excludeSocketId && id === excludeSocketId) continue;
    if (normalizeName(p.name) === normalizedName) {
      return id;
    }
  }
  return null;
}

function migrateSocketIdInActiveGame(oldSocketId, newSocketId) {
  if (!oldSocketId || !newSocketId || oldSocketId === newSocketId) return;

  if (activeQuiz) {
    if (activeQuiz.hostId === oldSocketId) {
      activeQuiz.hostId = newSocketId;
    }
    if (activeQuiz.readySet && activeQuiz.readySet.has(oldSocketId)) {
      activeQuiz.readySet.delete(oldSocketId);
      activeQuiz.readySet.add(newSocketId);
    }
    if (activeQuiz.answeredCurrent && activeQuiz.answeredCurrent.has(oldSocketId)) {
      activeQuiz.answeredCurrent.delete(oldSocketId);
      activeQuiz.answeredCurrent.add(newSocketId);
    }
    if (activeQuiz.scores && activeQuiz.scores[oldSocketId]) {
      activeQuiz.scores[newSocketId] = activeQuiz.scores[oldSocketId];
      delete activeQuiz.scores[oldSocketId];
    }
    if (activeQuiz.votes && Object.prototype.hasOwnProperty.call(activeQuiz.votes, oldSocketId)) {
      activeQuiz.votes[newSocketId] = activeQuiz.votes[oldSocketId];
      delete activeQuiz.votes[oldSocketId];
    }
  }

  if (activeTelephoneGame) {
    if (activeTelephoneGame.starterId === oldSocketId) {
      activeTelephoneGame.starterId = newSocketId;
    }
    if (activeTelephoneGame.typistId === oldSocketId) {
      activeTelephoneGame.typistId = newSocketId;
    }
  }
}

function recordLogEntry(message, avatar) {
  const entry = {
    message,
    avatar: avatar || '✨',
    timestamp: Date.now()
  };
  actionLogHistory.push(entry);
  if (actionLogHistory.length > MAX_LOG_HISTORY) {
    actionLogHistory = actionLogHistory.slice(actionLogHistory.length - MAX_LOG_HISTORY);
  }
  io.emit('action_log', entry);
}

function syncPlayerStatsToMemory(player) {
  if (!player || !player.name) return;
  const key = normalizeName(player.name);
  if (!key) return;
  const existing = savedPlayerStatsByName[key];
  savedPlayerStatsByName[key] = {
    social: player.social,
    fun: player.fun,
    drunk: player.drunk,
    isBirthdayGirl: !!player.isBirthdayGirl,
    lastDuelTime: player.lastDuelTime || (existing ? existing.lastDuelTime : 0) || 0
  };
}

function syncAllPlayersToMemory() {
  for (const id in players) {
    syncPlayerStatsToMemory(players[id]);
  }
}

function isBirthdayGirlTaken(excludeSocketId = null) {
  return Object.entries(players).some(([id, p]) => {
    if (excludeSocketId && id === excludeSocketId) return false;
    return !!p.isBirthdayGirl;
  });
}

// Prirodno trežnjenje na svakih 60 sekundi i usklađivanje barova
setInterval(() => {
  let changed = false;
  for (const id in players) {
    if (players[id].drunk > 0) {
      players[id].drunk = Math.max(0, players[id].drunk - 2);
      changed = true;
    }
    if (players[id].drunk >= 100) {
      players[id].fun = 100;
      if (players[id].social > 50) players[id].social = 50;
      changed = true;
    }
  }
  for (const key in savedPlayerStatsByName) {
    const stat = savedPlayerStatsByName[key];
    if (stat.drunk > 0) {
      stat.drunk = Math.max(0, stat.drunk - 2);
    }
    if (stat.drunk >= 100) {
      stat.fun = 100;
      if (stat.social > 50) stat.social = 50;
    }
  }
  if (changed) {
    syncAllPlayersToMemory();
    io.emit('update_players', players);
  }
}, 60 * 1000);

function getActivePartyPlayerIds() {
  return Object.keys(players).filter(id => !lobbySockets.has(id));
}

function broadcastQuizReadyState() {
  if (!activeQuiz || activeQuiz.phase !== 'waiting_ready') return;

  const partyIds = getActivePartyPlayerIds();
  const readyNames = [];
  const waitingNames = [];

  partyIds.forEach(id => {
    if (!players[id]) return;
    if (activeQuiz.readySet.has(id)) {
      readyNames.push(players[id].name);
    } else {
      waitingNames.push(players[id].name);
    }
  });

  io.emit('quiz_ready_update', {
    readyCount: readyNames.length,
    totalCount: partyIds.length,
    readyNames,
    waitingNames
  });

  if (partyIds.length > 0 && partyIds.every(id => activeQuiz.readySet.has(id))) {
    activeQuiz.phase = 'running';

    const scores = {};
    partyIds.forEach(id => {
      scores[id] = { firstCorrect: 0, totalCorrect: 0 };
    });
    activeQuiz.scores = scores;

    recordLogEntry(`🚀 SVI SU SPREMNI! Kviz počinje sada!`, '🧠');

    runQuizStep(0);
  }
}

function clearActiveQuizTimer() {
  if (activeQuiz && activeQuiz.timer) {
    clearTimeout(activeQuiz.timer);
    activeQuiz.timer = null;
  }
}

function resolveCurrentQuizQuestion() {
  if (!activeQuiz || activeQuiz.phase !== 'running') return;
  clearActiveQuizTimer();

  const index = activeQuiz.currentQuestion;
  const qObj = quizQuestions[index];
  if (!qObj) {
    finishQuiz();
    return;
  }

  if (qObj.isVote) {
    const counts = [0, 0, 0];
    Object.values(activeQuiz.votes).forEach(optIdx => {
      if (counts[optIdx] !== undefined) counts[optIdx]++;
    });

    let maxVotes = -1;
    let winningIdx = 0;
    for (let i = 0; i < 3; i++) {
      if (counts[i] > maxVotes) {
        maxVotes = counts[i];
        winningIdx = i;
      }
    }

    const winningPenalty = qObj.options[winningIdx];
    activeQuiz.winningPenalty = winningPenalty;

    io.emit('quiz_vote_result', {
      winningOption: winningPenalty,
      counts: counts,
      options: qObj.options
    });

    recordLogEntry(
      `🗳️ QUIZZ GLASANJE: Izglasano je da gubitnik kviza popije/dobije 7 ${winningPenalty.toUpperCase()}! (${maxVotes} glasova)`,
      '🗳️'
    );

    activeQuiz.timer = setTimeout(() => {
      finishQuiz();
    }, 4000);
  } else {
    runQuizStep(index + 1);
  }
}

function checkAllAnsweredCurrentQuestion() {
  if (!activeQuiz || activeQuiz.phase !== 'running') return;
  const qObj = quizQuestions[activeQuiz.currentQuestion];
  if (!qObj) return;

  const partyIds = getActivePartyPlayerIds();
  const expectedRespondentIds = qObj.isVote
    ? partyIds
    : partyIds.filter(id => id !== activeQuiz.hostId);

  if (expectedRespondentIds.length > 0 && expectedRespondentIds.every(id => activeQuiz.answeredCurrent.has(id))) {
    resolveCurrentQuizQuestion();
  }
}

function runQuizStep(index) {
  if (!activeQuiz) return;

  if (index >= quizQuestions.length) {
    finishQuiz();
    return;
  }

  activeQuiz.currentQuestion = index;
  activeQuiz.answeredCurrent = new Set();
  activeQuiz.firstCorrectClaimed = false;

  const qObj = quizQuestions[index];

  io.emit('quiz_question', {
    index: index,
    total: quizQuestions.length,
    question: qObj.q,
    options: qObj.options,
    isVote: qObj.isVote,
    hostId: activeQuiz.hostId,
    durationSec: 10
  });

  activeQuiz.timer = setTimeout(() => {
    resolveCurrentQuizQuestion();
  }, 10000);
}

function finishQuiz() {
  if (!activeQuiz) return;
  clearActiveQuizTimer();

  const hostId = activeQuiz.hostId;
  const scores = activeQuiz.scores || {};
  const penalty = activeQuiz.winningPenalty || "kaznenih pića";

  const participantIds = Object.keys(scores).filter(id => id !== hostId && players[id]);

  let topFirstName = "Niko (niko nije pogodio prvi)";
  let topFirstCount = 0;

  let lowestScoreNames = [];
  let minCorrect = Infinity;

  participantIds.forEach(id => {
    const pData = scores[id];
    const pName = players[id].name;

    if (pData.firstCorrect > topFirstCount) {
      topFirstCount = pData.firstCorrect;
      topFirstName = `${pName} (${topFirstCount}x prvi tačan)`;
    } else if (pData.firstCorrect === topFirstCount && topFirstCount > 0) {
      topFirstName += `, ${pName} (${topFirstCount}x)`;
    }

    if (pData.totalCorrect < minCorrect) {
      minCorrect = pData.totalCorrect;
      lowestScoreNames = [`${pName} (${pData.totalCorrect}/6)`];
    } else if (pData.totalCorrect === minCorrect) {
      lowestScoreNames.push(`${pName} (${pData.totalCorrect}/6)`);
    }
  });

  const loserSummary = lowestScoreNames.length > 0
    ? lowestScoreNames.join(', ')
    : "Nema učesnika";

  if (players[hostId]) {
    io.to(hostId).emit('quiz_end_host', {
      topFirst: topFirstName,
      lowest: loserSummary,
      penalty: penalty
    });
  }

  for (const id in players) {
    if (id === hostId || lobbySockets.has(id)) continue;
    const myTotal = scores[id] ? scores[id].totalCorrect : 0;
    io.to(id).emit('quiz_end_player', {
      totalCorrect: myTotal,
      totalQuestions: 6,
      penalty: penalty
    });
  }

  recordLogEntry(
    `🧠 QUIZZ TIME ZAVRŠEN! Najbrži znalac: ${topFirstName} | Najmanje pogodaka: ${loserSummary} -> Kazna: 7 ${penalty}!`,
    '🏆'
  );

  activeQuiz = null;
}

function sendJoinedPlayerState(socket, player, showBirthdayGreeting = false) {
  const now = Date.now();
  const rem = getDeviceRemainingCooldowns(player.deviceKey, now);

  socket.emit('sync_cooldowns', {
    telephoneRemaining: rem.telephoneRemaining,
    woohooRemaining: rem.woohooRemaining,
    duelRemaining: rem.duelRemaining
  });

  socket.emit('quiz_used_status', { used: quizUsed });
  socket.emit('log_history', actionLogHistory);

  socket.emit('join_success', {
    name: player.name,
    avatar: player.avatar,
    isBirthdayGirl: !!player.isBirthdayGirl,
    showBirthdayGreeting: !!showBirthdayGreeting && !!player.isBirthdayGirl
  });

  if (activeQuiz && activeQuiz.phase === 'waiting_ready') {
    socket.emit('quiz_ready_prompt', {
      hostName: players[activeQuiz.hostId] ? players[activeQuiz.hostId].name : 'Slavljenica'
    });
    broadcastQuizReadyState();
  }

  io.emit('update_players', players);
  io.emit('birthday_status', { taken: isBirthdayGirlTaken() });
}

io.on('connection', (socket) => {
  console.log('Novi Sim se priključio u lobi:', socket.id);
  lobbySockets.add(socket.id);

  socket.emit('birthday_status', { taken: isBirthdayGirlTaken() });
  socket.emit('log_history', actionLogHistory);

  socket.on('probe_cooldowns', ({ deviceId } = {}) => {
    const devKey = getDeviceKey(socket, deviceId);
    const rem = getDeviceRemainingCooldowns(devKey, Date.now());
    socket.emit('sync_cooldowns', rem);
  });

  socket.on('join', ({ name, avatar, isBirthdayGirl, birthdayPassword, deviceId }) => {
    const cleanName = (name || '').trim().replace(/\s+/g, ' ') || 'Sim';
    const normKey = normalizeName(cleanName);
    const devKey = getDeviceKey(socket, deviceId);

    if (isNameTakenByActivePlayer(normKey, socket.id)) {
      socket.emit('join_error', `Ime "${cleanName}" je već zauzeto na žurci! Izaberi drugo ime.`);
      return;
    }

    const alreadyHasBirthday = isBirthdayGirlTaken(socket.id);
    let finalIsBirthdayGirl = false;

    if (isBirthdayGirl) {
      if (alreadyHasBirthday) {
        socket.emit('birthday_error', 'Slavljenica je već na žurci! Može biti samo jedna.');
        return;
      }
      if (!birthdayPassword || birthdayPassword.trim().toLowerCase() !== BIRTHDAY_PASSWORD) {
        socket.emit('birthday_error', 'Pogrešna šifra za slavljenicu! Nisi slavljenica, ne foliraj se! 😜');
        return;
      }
      finalIsBirthdayGirl = true;
    }

    const previousStats = savedPlayerStatsByName[normKey];
    if (!finalIsBirthdayGirl && previousStats && previousStats.isBirthdayGirl && !alreadyHasBirthday) {
      finalIsBirthdayGirl = true;
    }

    const cdRec = ensureDeviceCooldownRecord(devKey);
    const restoredLastDuelTime = Math.max(
      previousStats ? (previousStats.lastDuelTime || 0) : 0,
      cdRec.duelUntil > 0 ? (cdRec.duelUntil - DUEL_COOLDOWN_MS) : 0
    );

    lobbySockets.delete(socket.id);

    players[socket.id] = {
      id: socket.id,
      name: cleanName,
      avatar: avatar || '🧔',
      deviceKey: devKey,
      isBirthdayGirl: finalIsBirthdayGirl,
      social: previousStats ? previousStats.social : 80,
      fun: previousStats ? previousStats.fun : 80,
      drunk: previousStats ? previousStats.drunk : 0,
      lastDuelTime: restoredLastDuelTime
    };

    syncPlayerStatsToMemory(players[socket.id]);
    sendJoinedPlayerState(socket, players[socket.id], finalIsBirthdayGirl);
  });

  // Tihi oporavak sesije posle zaključavanja ekrana, refresh-a ili kratkog prekida veze
  socket.on('rejoin', ({ name, avatar, isBirthdayGirl, birthdayPassword, deviceId }) => {
    const devKey = getDeviceKey(socket, deviceId);

    if (players[socket.id] && !lobbySockets.has(socket.id)) {
      players[socket.id].deviceKey = devKey;
      sendJoinedPlayerState(socket, players[socket.id], false);
      return;
    }

    const cleanName = (name || '').trim().replace(/\s+/g, ' ');
    const normKey = normalizeName(cleanName);
    if (!normKey) {
      socket.emit('sync_cooldowns', getDeviceRemainingCooldowns(devKey, Date.now()));
      return;
    }

    const previousStats = savedPlayerStatsByName[normKey];
    const staleSocketId = findActiveSocketIdByNormalizedName(normKey, socket.id);

    const alreadyHasBirthday = isBirthdayGirlTaken(staleSocketId || socket.id);
    let finalIsBirthdayGirl = false;

    if (isBirthdayGirl) {
      if (alreadyHasBirthday) {
        finalIsBirthdayGirl = false;
      } else if (
        (previousStats && previousStats.isBirthdayGirl) ||
        (birthdayPassword && birthdayPassword.trim().toLowerCase() === BIRTHDAY_PASSWORD)
      ) {
        finalIsBirthdayGirl = true;
      }
    }

    if (!finalIsBirthdayGirl && previousStats && previousStats.isBirthdayGirl && !alreadyHasBirthday) {
      finalIsBirthdayGirl = true;
    }

    if (staleSocketId) {
      const oldPlayer = players[staleSocketId];
      if (oldPlayer) {
        syncPlayerStatsToMemory(oldPlayer);
      }
      migrateSocketIdInActiveGame(staleSocketId, socket.id);
      delete players[staleSocketId];
      lobbySockets.delete(staleSocketId);
    }

    const cdRec = ensureDeviceCooldownRecord(devKey);
    const restoredLastDuelTime = Math.max(
      previousStats ? (previousStats.lastDuelTime || 0) : 0,
      cdRec.duelUntil > 0 ? (cdRec.duelUntil - DUEL_COOLDOWN_MS) : 0
    );

    lobbySockets.delete(socket.id);

    players[socket.id] = {
      id: socket.id,
      name: cleanName,
      avatar: avatar || (players[staleSocketId] && players[staleSocketId].avatar) || '🧔',
      deviceKey: devKey,
      isBirthdayGirl: finalIsBirthdayGirl,
      social: previousStats ? previousStats.social : 80,
      fun: previousStats ? previousStats.fun : 80,
      drunk: previousStats ? previousStats.drunk : 0,
      lastDuelTime: restoredLastDuelTime
    };

    syncPlayerStatsToMemory(players[socket.id]);
    sendJoinedPlayerState(socket, players[socket.id], false);
  });

  // Pokretanje QUIZZ TIME lobija spremnosti (samo slavljenica i samo jednom)
  socket.on('start_quiz', () => {
    if (lobbySockets.has(socket.id)) return;
    const sender = players[socket.id];
    if (!sender || !sender.isBirthdayGirl) return;
    if (quizUsed || activeQuiz) return;

    quizUsed = true;
    io.emit('quiz_used_status', { used: true });

    activeQuiz = {
      hostId: socket.id,
      phase: 'waiting_ready',
      readySet: new Set(),
      currentQuestion: 0,
      scores: {},
      answeredCurrent: new Set(),
      firstCorrectClaimed: false,
      votes: {},
      timer: null,
      winningPenalty: ''
    };

    recordLogEntry(
      `🧠 QUIZZ TIME! Slavljenica ${sender.name} je pokrenula kviz! Svi moraju da kliknu da su spremni!`,
      '🎂'
    );

    io.emit('quiz_ready_prompt', { hostName: sender.name });
    broadcastQuizReadyState();
  });

  // Potvrda spremnosti svakog igrača
  socket.on('quiz_player_ready', () => {
    if (!activeQuiz || activeQuiz.phase !== 'waiting_ready') return;
    if (lobbySockets.has(socket.id) || !players[socket.id]) return;

    activeQuiz.readySet.add(socket.id);
    broadcastQuizReadyState();
  });

  socket.on('quiz_answer', ({ questionIndex, optionIndex }) => {
    if (!activeQuiz || activeQuiz.phase !== 'running') return;
    if (activeQuiz.currentQuestion !== questionIndex) return;
    if (activeQuiz.answeredCurrent.has(socket.id)) return;

    const qObj = quizQuestions[questionIndex];
    if (!qObj) return;

    if (!qObj.isVote && socket.id === activeQuiz.hostId) return;

    activeQuiz.answeredCurrent.add(socket.id);

    if (qObj.isVote) {
      activeQuiz.votes[socket.id] = optionIndex;
      socket.emit('quiz_answer_ack', { isVote: true });
    } else {
      if (!activeQuiz.scores[socket.id]) {
        activeQuiz.scores[socket.id] = { firstCorrect: 0, totalCorrect: 0 };
      }

      const isCorrect = (optionIndex === qObj.correct);
      let isFirst = false;

      if (isCorrect) {
        activeQuiz.scores[socket.id].totalCorrect += 1;
        if (!activeQuiz.firstCorrectClaimed) {
          activeQuiz.firstCorrectClaimed = true;
          activeQuiz.scores[socket.id].firstCorrect += 1;
          isFirst = true;
        }
      }

      socket.emit('quiz_answer_ack', {
        isVote: false,
        isCorrect: isCorrect,
        isFirst: isFirst
      });
    }

    checkAllAnsweredCurrentQuestion();
  });

  socket.on('interaction', ({ targetId, action, customText }) => {
    if (lobbySockets.has(socket.id)) return;
    const sender = players[socket.id];
    const target = players[targetId];

    if (!sender || !target) return;

    let message = '';
    let scoreChange = 3;

    if (action === 'chat') {
      message = `${sender.name} ćaska sa ${target.name}.`;
      scoreChange = 3;
    } else if (action === 'joke') {
      message = `${sender.name} priča vic liku ${target.name}! Smeh na žurci.`;
      scoreChange = 5;
    } else if (action === 'hug') {
      message = `${sender.name} grli ${target.name}. Baš slatko!`;
      scoreChange = 5;
    } else if (action === 'gossip') {
      message = `${sender.name} tračari sa ${target.name}! Šok i neverica!`;
      scoreChange = 2;
    } else if (action === 'flirt') {
      message = `${sender.name} flertuje sa ${target.name}! Ooo...`;
      scoreChange = 6;
    } else if (action === 'dance') {
      message = `${sender.name} poziva ${target.name} na ples! Ludnica!`;
      scoreChange = 8;
    } else if (action === 'insult') {
      message = `${sender.name} vređa ${target.name}! Drama!`;
      scoreChange = -10;
    } else if (action === 'custom') {
      const cleanCustom = String(customText || '').trim().replace(/\s+/g, ' ');
      if (!cleanCustom) return;
      message = `${sender.name} ${cleanCustom} sa ${target.name}!`;
      scoreChange = 4;
    }

    target.social = Math.min(100, Math.max(0, target.social + scoreChange));
    target.fun = Math.min(100, Math.max(0, target.fun + scoreChange));
    syncPlayerStatsToMemory(target);

    const pairKey = `${socket.id}-${targetId}`;
    if (!lastActions[pairKey]) {
      lastActions[pairKey] = { action: action, count: 1 };
    } else {
      if (lastActions[pairKey].action === action) {
        lastActions[pairKey].count += 1;
      } else {
        lastActions[pairKey] = { action: action, count: 1 };
      }
    }

    if (lastActions[pairKey].count === 3) {
      lastActions[pairKey].count = 0;
      let spamTitle = "";
      let spamMsg = "";

      switch (action) {
        case 'insult':
          spamTitle = "VREĐANJE U NEDOGLED!";
          spamMsg = "ALO MANIJAČE, uzmi pilule za lilule.";
          break;
        case 'flirt':
          spamTitle = "PRETERANI FLERT!";
          spamMsg = "JAOO VRAGOLANE!";
          break;
        case 'gossip':
          spamTitle = "TRAČARA GORI!";
          spamMsg = "GO-PISS GIRL!";
          break;
        case 'joke':
          spamTitle = "BESKRAJNI VIC!";
          spamMsg = "ŠALJIVDŽIJA, JEL?!";
          break;
        case 'hug':
          spamTitle = "NEPUŠTAJUĆI ZAGRLJAJ!";
          spamMsg = "DOBAR PRIJATELJ ILI MANIJAK?!";
          break;
        case 'chat':
          spamTitle = "NEPRESTANO ĆASKANJE!";
          spamMsg = "NE SMARAŠ, KAŽI!?";
          break;
        case 'dance':
          spamTitle = "LUDILO NA PODIJUMU!";
          spamMsg = "A ONA IGRA, VRTI SE KAO ČIGRA!";
          break;
      }

      if (spamMsg) {
        socket.emit('trigger_spam_popup', { title: spamTitle, message: spamMsg });
        recordLogEntry(
          `⚠️ SPAM ALERT: ${sender.name} je smorio ${target.name} sa akcijom "${action}"! (${spamMsg})`,
          '⚡'
        );
      }
    }

    recordLogEntry(message, sender.avatar);
    io.emit('update_players', players);
  });

  socket.on('drink_duel', ({ targetId }) => {
    if (lobbySockets.has(socket.id)) return;
    const sender = players[socket.id];
    const target = players[targetId];

    if (!sender || !target) return;

    const now = Date.now();
    const devKey = sender.deviceKey || getDeviceKey(socket);
    const cdRec = ensureDeviceCooldownRecord(devKey);

    if (now < cdRec.duelUntil || (now - sender.lastDuelTime < DUEL_COOLDOWN_MS)) {
      const rem = Math.max(cdRec.duelUntil - now, DUEL_COOLDOWN_MS - (now - sender.lastDuelTime), 0);
      socket.emit('duel_cooldown_started', { durationMs: rem });
      return;
    }

    const duelUntil = now + DUEL_COOLDOWN_MS;
    cdRec.duelUntil = duelUntil;
    sender.lastDuelTime = now;
    syncPlayerStatsToMemory(sender);

    socket.emit('duel_cooldown_started', { durationMs: DUEL_COOLDOWN_MS });

    const logMessage = `⚔️ DUEL PIĆA: ${sender.name} je izazvao ${target.name} na ispijanje pića! 🍻`;
    recordLogEntry(logMessage, '⚔️');

    socket.emit('play_duel_sound');

    if (!lobbySockets.has(targetId)) {
      io.to(targetId).emit('play_duel_sound');
      io.to(targetId).emit('trigger_duel_popup', {
        senderName: sender.name
      });
    }
  });

  socket.on('duel_response', ({ response }) => {
    if (lobbySockets.has(socket.id)) return;
    const sender = players[socket.id];
    if (!sender) return;

    let message = '';
    if (response === 'accepted') {
      sender.drunk = Math.min(100, sender.drunk + 10);
      sender.fun = Math.min(100, sender.fun + 15);

      if (sender.drunk >= 100) {
        sender.drunk = 100;
        sender.fun = 100;
        sender.social = Math.min(sender.social, 50);
      }

      message = `✅ ${sender.name} je prihvatio izazov i popio piće! (Pijanost: ${sender.drunk}%) 🍻`;

      if (sender.drunk >= 100) {
        io.to(socket.id).emit('trigger_balzamovan');
      }
    } else {
      message = `❌ ${sender.name} je kukavički ODBIO izazov na piće! Sramota!`;
    }

    syncPlayerStatsToMemory(sender);
    recordLogEntry(message, response === 'accepted' ? '🍻' : '🐔');
    io.emit('update_players', players);
  });

  socket.on('woohoo_chaos', () => {
    if (lobbySockets.has(socket.id)) return;
    const sender = players[socket.id];
    if (!sender) return;

    const now = Date.now();
    const devKey = sender.deviceKey || getDeviceKey(socket);
    const cdRec = ensureDeviceCooldownRecord(devKey);

    if (now < cdRec.woohooUntil) {
      socket.emit('woohoo_cooldown_started', { durationMs: cdRec.woohooUntil - now });
      return;
    }

    const woohooUntil = now + EVENT_COOLDOWN_MS;
    cdRec.woohooUntil = woohooUntil;
    globalCooldowns.woohoo = now;
    socket.emit('woohoo_cooldown_started', { durationMs: EVENT_COOLDOWN_MS });

    const randomWord = chaosPrompts[Math.floor(Math.random() * chaosPrompts.length)];
    activeWooHoo = { word: randomWord, clicks: [] };

    const message = `🗣️ WOOHOO CHAOS (${sender.name}): Svi viču reč -> "${randomWord}"! Ko zadnji klikne, pije!`;

    for (const id in players) {
      players[id].fun = Math.min(100, players[id].fun + 10);
    }
    syncAllPlayersToMemory();

    recordLogEntry(message, '🗣️');

    for (const id in players) {
      if (!lobbySockets.has(id)) {
        io.to(id).emit('trigger_chaos_popup', { senderName: sender.name, word: randomWord });
      }
    }

    setTimeout(() => {
      if (!activeWooHoo) return;
      let loserId = null;
      if (activeWooHoo.clicks.length > 0) {
        loserId = activeWooHoo.clicks[activeWooHoo.clicks.length - 1].socketId;
      }

      if (loserId && players[loserId]) {
        const loser = players[loserId];
        loser.drunk = Math.min(100, loser.drunk + 15);
        if (loser.drunk >= 100) {
          loser.drunk = 100;
          loser.fun = 100;
          loser.social = Math.min(loser.social, 50);
        } else {
          loser.fun = Math.max(0, loser.fun - 15);
        }
        syncPlayerStatsToMemory(loser);

        const failMessage = `🚨 WOO-HOO REZULTAT: ${loser.name} je poslednji viknuo "${activeWooHoo.word}" i pije kazneno piće! (Pijanost: ${loser.drunk}%) 🍻`;
        recordLogEntry(failMessage, '🤡');

        if (loser.drunk >= 100) {
          io.to(loserId).emit('trigger_balzamovan');
        }

        io.emit('update_players', players);
      }
      activeWooHoo = null;
    }, 6000);
  });

  socket.on('woohoo_shouted', () => {
    if (!activeWooHoo) return;
    const alreadyClicked = activeWooHoo.clicks.some(c => c.socketId === socket.id);
    if (!alreadyClicked) {
      activeWooHoo.clicks.push({ socketId: socket.id, time: Date.now() });
    }
  });

  socket.on('start_telephone_game', () => {
    if (lobbySockets.has(socket.id)) return;
    const sender = players[socket.id];
    if (!sender) return;

    const now = Date.now();
    const devKey = sender.deviceKey || getDeviceKey(socket);
    const cdRec = ensureDeviceCooldownRecord(devKey);

    if (now < cdRec.telephoneUntil) {
      socket.emit('telephone_cooldown_started', { durationMs: cdRec.telephoneUntil - now });
      return;
    }

    const partyPlayerIds = getActivePartyPlayerIds();
    if (partyPlayerIds.length < 2) {
      recordLogEntry(`⚠️ Nema dovoljno Simsa na žurci za Gluve telefone (minimum 2).`, '⚠️');
      return;
    }

    const telephoneUntil = now + TELEPHONE_COOLDOWN_MS;
    cdRec.telephoneUntil = telephoneUntil;
    globalCooldowns.telephone = now;
    socket.emit('telephone_cooldown_started', { durationMs: TELEPHONE_COOLDOWN_MS });

    const phrase = simsPhrases[Math.floor(Math.random() * simsPhrases.length)];
    const starterId = partyPlayerIds[Math.floor(Math.random() * partyPlayerIds.length)];
    let typistId;
    do {
      typistId = partyPlayerIds[Math.floor(Math.random() * partyPlayerIds.length)];
    } while (typistId === starterId && partyPlayerIds.length > 1);

    activeTelephoneGame = {
      phrase: phrase,
      starterId: starterId,
      typistId: typistId
    };

    const starterName = players[starterId].name;
    const typistName = players[typistId].name;

    partyPlayerIds.forEach(id => {
      io.to(id).emit('telephone_rules_popup', {
        starterName,
        typistName,
        triggerName: sender.name
      });
    });

    recordLogEntry(
      `📞 GLUVI TELEFONI (${sender.name} pokrenuo): Tajnu frazu zna ${starterName}, a poslednji kucač je ${typistName}! Ponesite vesti!`,
      '📞'
    );

    setTimeout(() => {
      if (!activeTelephoneGame) return;
      io.to(starterId).emit('telephone_role_starter', { phrase });
      io.to(typistId).emit('telephone_role_typist');
    }, 7000);
  });

  socket.on('telephone_submit', ({ guess }) => {
    if (!activeTelephoneGame) return;
    if (socket.id !== activeTelephoneGame.typistId) return;

    const normalizedGuess = guess.toLowerCase().replace(/\s+/g, '');
    const normalizedTarget = activeTelephoneGame.phrase.toLowerCase().replace(/\s+/g, '');

    const isCorrect = normalizedGuess === normalizedTarget;

    if (isCorrect) {
      io.emit('telephone_result', {
        success: true,
        phrase: activeTelephoneGame.phrase,
        message: `🎉 BRAVO GLUVAĆI! Uspešno ste preneli frazu "${activeTelephoneGame.phrase}"! Niko ne pije, svaka čast!`
      });
      recordLogEntry(`🎉 GLUVI TELEFONI USPEH: Fraza "${activeTelephoneGame.phrase}" je tačno preneta!`, '🏆');
    } else {
      for (const id in players) {
        players[id].drunk = Math.min(100, players[id].drunk + 15);
        if (players[id].drunk >= 100) {
          players[id].drunk = 100;
          players[id].fun = 100;
          players[id].social = Math.min(players[id].social, 50);
          io.to(id).emit('trigger_balzamovan');
        }
      }
      syncAllPlayersToMemory();
      io.emit('telephone_result', {
        success: false,
        phrase: activeTelephoneGame.phrase,
        guess: guess,
        message: `🍻 SVI PIJETE GLUVAĆI! Konačan kucač je promašio! Traženo je bilo: "${activeTelephoneGame.phrase}", a ukucano je: "${guess}".`
      });
      recordLogEntry(`🍻 GLUVI TELEFONI PROMAŠAJ: SVI PIJU! Original: "${activeTelephoneGame.phrase}"`, '🤡');
      io.emit('update_players', players);
    }

    activeTelephoneGame = null;
  });

  socket.on('disconnect', () => {
    const departedPlayer = players[socket.id];
    if (departedPlayer) {
      syncPlayerStatsToMemory(departedPlayer);
    }

    if (
      activeTelephoneGame &&
      (socket.id === activeTelephoneGame.starterId || socket.id === activeTelephoneGame.typistId)
    ) {
      const leftName = departedPlayer ? departedPlayer.name : 'Učesnik';
      activeTelephoneGame = null;
      recordLogEntry(
        `⚠️ GLUVI TELEFONI PREKINUTI: ${leftName} je napustio žurku usred runde.`,
        '📞'
      );
    }

    delete players[socket.id];
    lobbySockets.delete(socket.id);

    if (activeQuiz && activeQuiz.phase === 'waiting_ready') {
      activeQuiz.readySet.delete(socket.id);
      broadcastQuizReadyState();
    } else if (activeQuiz && activeQuiz.phase === 'running') {
      checkAllAnsweredCurrentQuestion();
    }

    io.emit('update_players', players);
    io.emit('birthday_status', { taken: isBirthdayGirlTaken() });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server radi na portu ${PORT}`);
});