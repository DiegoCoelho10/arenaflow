/* ============================================================
   ARENAFLOW — APP.JS
   Complete SPA: Auth, Student, Arena Admin, Superadmin
   ============================================================ */

'use strict';

// ── Helpers Fase 1 (plano gratuito: lógica em transações + Rules) ──

// Auto-reparo: garante o doc do aluno em arenas/{id}/students/{uid}
// (corrige alunos antigos sem precisar de script de backfill)
async function ensureStudentDoc(arenaId, uid, profile) {
  const ref = db.collection('arenas').doc(arenaId).collection('students').doc(uid);
  const snap = await ref.get().catch(()=>null);
  if (snap && snap.exists) return;
  await ref.set({
    name: profile?.name || '',
    email: profile?.email || '',
    photoBase64: profile?.photoBase64 || null,
    status: 'active',
    tipo: null, nivel: null, slots: [],
    totalClasses: 0, monthClasses: 0, streakWeeks: 0,
    badges: profile?.badges || ['first'],
    joinedAt: firebase.firestore.FieldValue.serverTimestamp()
  }).catch(e => console.warn('ensureStudentDoc:', e?.message));
}

// Janela de inscrição configurável por arena (defaults 24h/12h)
function getEnrollWindowHours(tipo) {
  const s = App.arena?.settings || {};
  return (tipo === 'mensalista')
    ? (s.enrollMensalistaHours ?? 24)
    : (s.enrollAvulsoHours ?? 12);
}

// ── EQUIPE (multi-gestor) ────────────────────────────────────
// Dono da arena = arena.gestorUid; funcionários entram pela
// lista arena.staffEmails (Config → Equipe)

// Aluno habilitado para a aula? Decidido pelo NÍVEL.
// Aula sem nível ou "todos" = aberta para qualquer aluno.
function nivelMatches(clsNivel, studentNivel) {
  if (!clsNivel || clsNivel === 'todos') return true;
  if (!studentNivel) return false;
  if (studentNivel === 'intermediario_avancado') {
    return ['intermediario','avancado','intermediario_avancado'].includes(clsNivel);
  }
  if (clsNivel === 'intermediario_avancado') {
    return studentNivel === 'intermediario' || studentNivel === 'avancado';
  }
  return clsNivel === studentNivel;
}

function isArenaOwner() {
  return App.role === 'arena_admin'
    && App.arena?.gestorUid === App.user?.uid;
}

async function findStaffInvite(email) {
  if (!email) return null;
  const snap = await db.collection('arenas')
    .where('staffEmails', 'array-contains', email.toLowerCase())
    .limit(1).get().catch(()=>null);
  if (!snap || snap.empty) return null;
  return { id: snap.docs[0].id, ...snap.docs[0].data() };
}

function offerStaffInvite(arena, uid) {
  showModal({
    icon:'🤝', iconBg:'var(--primary-dim)',
    title:'Convite de equipe!',
    text:`Você foi convidado para a equipe da ${arena.name}. Como funcionário, você poderá criar aulas e gerenciar alunos e filas.`,
    actions:[
      {label:'Agora não', style:'btn-outline', id:'staff-decline', close:true},
      {label:'Aceitar e entrar', style:'btn-primary', id:'staff-accept', close:true}
    ]
  });
  window._modalCallbacks['staff-accept'] = async () => {
    showLoading();
    try {
      await db.collection('users').doc(uid).set({
        role: 'arena_admin',
        arenaId: arena.id,
        adminLevel: 'staff',
        email: (App.user.email||'').toLowerCase()
      }, { merge: true });
      await App.loadUserProfile(uid);
      showToast(`Bem-vindo à equipe da ${arena.name}! 🤝`,'success');
    } catch(e) {
      hideLoading();
      showToast('Erro ao aceitar convite — fale com o dono da arena','error');
      App.go(SCREENS.S_HOME);
    }
  };
  window._modalCallbacks['staff-decline'] = () => {
    App.arenaId = App.profile?.arenaId || null;
    App.go(App.arenaId ? SCREENS.S_HOME : SCREENS.S_HOME);
  };
}

window.addStaffEmail = async function() {
  const inp = document.getElementById('staff-email');
  const email = (inp?.value || '').trim().toLowerCase();
  if (!email || !email.includes('@')) { showToast('Digite um e-mail válido','error'); return; }
  if ((App.arena?.gestorEmail||'').toLowerCase() === email) {
    showToast('Esse é o e-mail do dono da arena','warning'); return;
  }
  showLoading();
  try {
    await db.collection('arenas').doc(App.arenaId).update({
      staffEmails: firebase.firestore.FieldValue.arrayUnion(email)
    });
    App.arena.staffEmails = [...(App.arena.staffEmails||[]), email];
    hideLoading();
    showToast('Funcionário adicionado! Peça para ele entrar no app com esse e-mail.','success');
    App.go(SCREENS.A_SETTINGS);
  } catch(e) { hideLoading(); showToast('Erro ao adicionar','error'); }
};

window.removeStaffEmail = async function(email) {
  confirmModal('Remover da equipe?', `${email} perderá o acesso de gestão imediatamente.`, '🚫', async () => {
    showLoading();
    try {
      await db.collection('arenas').doc(App.arenaId).update({
        staffEmails: firebase.firestore.FieldValue.arrayRemove(email)
      });
      App.arena.staffEmails = (App.arena.staffEmails||[]).filter(e => e !== email);
      // Rebaixa o usuário se já tinha aceitado o convite
      const uSnap = await db.collection('users')
        .where('arenaId','==',App.arenaId)
        .where('role','==','arena_admin').get().catch(()=>null);
      if (uSnap) {
        for (const d of uSnap.docs) {
          if ((d.data().email||'').toLowerCase() === email && d.id !== App.arena.gestorUid) {
            await db.collection('users').doc(d.id).update({
              role: 'student', adminLevel: firebase.firestore.FieldValue.delete()
            }).catch(()=>{});
          }
        }
      }
      hideLoading();
      showToast('Removido da equipe','warning');
      App.go(SCREENS.A_SETTINGS);
    } catch(e) { hideLoading(); showToast('Erro ao remover','error'); }
  });
};

// ── CONSTANTS ───────────────────────────────────────────────
const SCREENS = {
  SPLASH:'splash', LOGIN:'login', REGISTER:'register', FORGOT:'forgot',
  INVITE:'invite',
  S_HOME:'s-home', S_SCHEDULE:'s-schedule', S_CLASSES:'s-classes', S_NOTIFS:'s-notifs',
  S_RANKING:'s-ranking', S_PROFILE:'s-profile',
  A_HOME:'a-home', A_SCHEDULE:'a-schedule', A_CLASS:'a-class',
  A_CREATE:'a-create', A_STUDENTS:'a-students', A_STUDENT:'a-student',
  A_REPORTS:'a-reports', A_SETTINGS:'a-settings',
  SA_HOME:'sa-home', SA_ARENAS:'sa-arenas', SA_ARENA:'sa-arena',
  SA_NEW_ARENA:'sa-new-arena', SA_FINANCIAL:'sa-financial', SA_SETTINGS:'sa-settings'
};

const BADGES = [
  {id:'first',    emoji:'🌱', name:'Broto',           req:1,   type:'classes',          desc:'Participe da sua 1ª aula na arena'},
  {id:'b3',       emoji:'👟', name:'Estreante',        req:3,   type:'classes',          desc:'Complete 3 aulas e mostre que veio pra ficar'},
  {id:'b5',       emoji:'🏐', name:'Na Quadra',        req:5,   type:'classes',          desc:'Complete 5 aulas — você já faz parte da turma!'},
  {id:'b10',      emoji:'⚡', name:'Com Gás',          req:10,  type:'classes',          desc:'10 aulas concluídas — a energia não para!'},
  {id:'b15',      emoji:'🔥', name:'Pegando Fogo',     req:15,  type:'classes',          desc:'15 aulas — você está pegando fogo na quadra!'},
  {id:'b20',      emoji:'🌊', name:'Flow',             req:20,  type:'classes',          desc:'20 aulas — você entrou no ritmo, no flow!'},
  {id:'b25',      emoji:'💪', name:'Determinado',      req:25,  type:'classes',          desc:'25 aulas — determinação é o que não falta!'},
  {id:'b30',      emoji:'🎯', name:'Focado',           req:30,  type:'classes',          desc:'30 aulas com olho no objetivo. Foco total!'},
  {id:'b40',      emoji:'🦁', name:'Guerreiro',        req:40,  type:'classes',          desc:'40 aulas — raça e garra de verdade!'},
  {id:'b50',      emoji:'💎', name:'Diamante',         req:50,  type:'classes',          desc:'50 aulas! Marco histórico — você é Diamante!'},
  {id:'b60',      emoji:'🚀', name:'Decolando',        req:60,  type:'classes',          desc:'60 aulas — você decolou e não para mais!'},
  {id:'b70',      emoji:'🏆', name:'Campeão',          req:70,  type:'classes',          desc:'70 aulas — poucos chegam aqui. Você é um campeão!'},
  {id:'b80',      emoji:'👑', name:'Rei da Quadra',    req:80,  type:'classes',          desc:'80 aulas — a quadra tem um novo rei!'},
  {id:'b90',      emoji:'⭐', name:'Estrela',          req:90,  type:'classes',          desc:'90 aulas — você brilha como uma estrela!'},
  {id:'b100',     emoji:'🔱', name:'Elite ArenaFlow',  req:100, type:'classes',          desc:'100 aulas! Você é Elite ArenaFlow — lenda confirmada!'},
  {id:'b150',     emoji:'🌟', name:'Imortal',          req:150, type:'classes',          desc:'150 aulas — imortal na quadra e na história!'},
  {id:'b200',     emoji:'🎖️', name:'Hall da Fama',     req:200, type:'classes',          desc:'200 aulas — seu nome está no Hall da Fama!'},
  {id:'b300',     emoji:'🏅', name:'Patrimônio',       req:300, type:'classes',          desc:'300 aulas — você é um patrimônio desta arena!'},
  {id:'streak2',  emoji:'📅', name:'Pontual',          req:2,   type:'streak_weeks',     desc:'2 semanas seguidas sem faltar uma aula'},
  {id:'streak4',  emoji:'🗓️', name:'Consistente',      req:4,   type:'streak_weeks',     desc:'4 semanas seguidas — 1 mês perfeito!'},
  {id:'streak8',  emoji:'🔄', name:'Máquina',          req:8,   type:'streak_weeks',     desc:'8 semanas seguidas sem parar!'},
  {id:'streak12', emoji:'🧱', name:'Inabalável',       req:12,  type:'streak_weeks',     desc:'12 semanas seguidas — nada te para!'},
  {id:'streak26', emoji:'🌙', name:'Dedicado',         req:26,  type:'streak_weeks',     desc:'6 meses consecutivos de presença!'},
  {id:'streak52', emoji:'🌞', name:'Um Ano de Quadra', req:52,  type:'streak_weeks',     desc:'52 semanas seguidas — um ano inteiro!'},
  {id:'fairplay', emoji:'🤝', name:'Fair Play',        req:10,  type:'no_cancel',        desc:'10 aulas seguidas sem cancelar nenhuma'},
  {id:'reliable', emoji:'🛡️', name:'Confiável',        req:0,   type:'monthly_no_cancel',desc:'Passe um mês inteiro sem cancelamento'},
  {id:'fast',     emoji:'⚡', name:'Relâmpago',         req:0,   type:'fast_confirm',     desc:'Confirme em menos de 5 minutos após o convite'},
  {id:'founder',  emoji:'🏅', name:'Fundador',          req:0,   type:'special',          desc:'Cadastrou-se no 1º mês de funcionamento da arena'},
  {id:'birthday', emoji:'🎂', name:'Aniversariante',    req:0,   type:'special',          desc:'Participe de uma aula no mês do seu aniversário'},
  {id:'rainy',    emoji:'🌧️', name:'Chuva Não Para',    req:5,   type:'special',          desc:'5 aulas em dias de chuva — nada te para!'},
  {id:'lucky',    emoji:'🎭', name:'Sortudo',            req:3,   type:'waitlist_went',    desc:'Chamado da fila de espera 3x e foi em todas!'},
  {id:'social',   emoji:'💬', name:'Animado',            req:50,  type:'reactions',        desc:'Dê 50 reações nas conquistas dos colegas'},
  {id:'refer',    emoji:'🤙', name:'Embaixador',          req:1,   type:'referrals',       desc:'Indique um amigo que se cadastre na arena'},
  {id:'xmas',     emoji:'🎄', name:'Espírito Natalino',  req:0,   type:'seasonal',         desc:'Participe de uma aula em dezembro'},
  {id:'newyear',  emoji:'🎆', name:'Virada',              req:0,   type:'seasonal',         desc:'Aula na semana do ano novo'},
  {id:'summer',   emoji:'☀️', name:'Verão Total',         req:10,  type:'seasonal',         desc:'10 aulas no verão (Dez–Mar)'},
];

const STATUS_LABELS = {
  confirmed:'Confirmado', waiting:'Aguardando', waitlist:'Fila de Espera',
  invited:'Convidado', cancelled:'Cancelado', attended:'Participou',
  class_cancelled:'Aula cancelada'
};
const STATUS_CSS = {
  confirmed:'status-confirmed', waiting:'status-waiting', waitlist:'status-waitlist',
  invited:'status-invited', cancelled:'status-cancelled', attended:'status-attended',
  class_cancelled:'status-cancelled'
};

// Ref de notificação in-app de um aluno (doc novo com id automático)
function notifRef(arenaId, studentUid) {
  return db.collection('arenas').doc(arenaId)
    .collection('students').doc(studentUid)
    .collection('notifications').doc();
}
function notifData(type, title, text, clsId) {
  return { type, title, text, clsId: clsId || null, read: false,
    createdAt: firebase.firestore.FieldValue.serverTimestamp() };
}

// ── STATE ────────────────────────────────────────────────────
const App = {
  user: null,
  profile: null,
  role: null,       // 'student' | 'arena_admin' | 'superadmin'
  arenaId: null,
  arena: null,
  screen: SCREENS.SPLASH,
  params: {},
  prevScreen: null,
  navHidden: false,
  unsubscribers: [],

  init() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(()=>{});
    }
    this.tryFullscreen();
    auth.onAuthStateChanged(u => {
      if (u) {
        this.user = u;
        this.loadUserProfile(u.uid);
      } else {
        this.user = null; this.profile = null; this.role = null;
        this.go(SCREENS.SPLASH);
      }
    });
  },

 tryFullscreen() {
    const el = document.documentElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen ||
                el.mozRequestFullScreen || el.msRequestFullscreen;
    if (!req) return;
    const go = () => req.call(el).catch(() => {});
    // Tenta na primeira interação
    ['click','touchstart','touchend'].forEach(ev =>
      document.addEventListener(ev, function f() {
        go();
        document.removeEventListener(ev, f);
      }, {once: true, passive: true})
    );
    // Recupera fullscreen se o usuário sair sem querer
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement) {
        setTimeout(() => go(), 300);
      }
    });
  },

  async loadUserProfile(uid) {
    showLoading();
    try {
      if (uid === SUPERADMIN_UID) {
        this.role = 'superadmin';
        this.profile = { name: 'Super Admin', role: 'superadmin' };
        hideLoading();
        this.go(SCREENS.SA_HOME);
        return;
      }
      const snap = await db.collection('users').doc(uid).get();
      if (snap.exists) {
        this.profile = snap.data();
        this.role = this.profile.role;
        if (this.role === 'arena_admin') {
          this.arenaId = this.profile.arenaId;
          const arenaSnap = await db.collection('arenas').doc(this.arenaId).get();
          this.arena = arenaSnap.data();
          // Auto-claim: arena antiga sem dono registrado e o e-mail bate
          if (this.arena && !this.arena.gestorUid
              && (this.arena.gestorEmail||'').toLowerCase() === (this.user.email||'').toLowerCase()) {
            await db.collection('arenas').doc(this.arenaId)
              .update({ gestorUid: uid }).catch(()=>{});
            this.arena.gestorUid = uid;
          }
          if (this.arena?.status === 'suspended') {
            hideLoading();
            this.go(SCREENS.LOGIN);
            setTimeout(() => showModal({
              icon: '⚠️', iconBg: 'var(--warning-dim)',
              title: 'Acesso Suspenso',
              text: 'O acesso desta arena está suspenso. Entre em contato com o suporte ArenaFlow.',
              actions: [{label:'OK', style:'btn-outline', close:true}]
            }), 300);
            return;
          }
          hideLoading();
          this.go(SCREENS.A_HOME);
        } else {
          // Convite de equipe pendente? (dono adicionou este e-mail)
          const staffArena = await findStaffInvite(this.user.email);
          if (staffArena) {
            hideLoading();
            offerStaffInvite(staffArena, uid);
            return;
          }
          this.arenaId = this.profile.arenaId;
          if (this.arenaId) {
            const aSnap = await db.collection('arenas').doc(this.arenaId).get().catch(()=>null);
            this.arena = (aSnap && aSnap.exists) ? aSnap.data() : null;
            // Auto-reparo do vínculo (alunos antigos sem doc em /students)
            await ensureStudentDoc(this.arenaId, uid, this.profile);
            // Ficha do aluno (tipo/nível/status) é a fonte da verdade
            const sdSnap = await db.collection('arenas').doc(this.arenaId)
              .collection('students').doc(uid).get().catch(()=>null);
            if (sdSnap && sdSnap.exists) {
              const sd = sdSnap.data();
              this.profile = { ...this.profile,
                tipo: sd.tipo ?? null, nivel: sd.nivel ?? null,
                status: sd.status || 'active' };
            }
          }
          hideLoading();
          this.go(SCREENS.S_HOME);
        }
      } else {
        hideLoading();
        this.go(SCREENS.SPLASH);
      }
    } catch(e) {
      hideLoading();
      showToast('Erro ao carregar perfil', 'error');
      this.go(SCREENS.SPLASH);
    }
  },

  go(screen, params = {}) {
    this.prevScreen = this.screen;
    this.screen = screen;
    this.params = params;
    this.unsubscribers.forEach(u => u && u());
    this.unsubscribers = [];
    hideLoading();
    renderScreen(screen, params);
    renderNav(screen);
    document.getElementById('screen-container').scrollTop = 0;
  },

  back() {
    if (this.prevScreen) this.go(this.prevScreen);
  }
};

// ── UI HELPERS ───────────────────────────────────────────────
function showLoading()  { document.getElementById('loading-overlay').classList.remove('hidden'); }
function hideLoading()  { document.getElementById('loading-overlay').classList.add('hidden'); }

function showToast(msg, type='', duration=2800) {
  const icons = { success:'✅', error:'❌', warning:'⚠️', '' :'ℹ️' };
  const c = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = `toast ${type ? 'toast-'+type : ''}`;
  t.innerHTML = `<span>${icons[type]||''}</span> ${msg}`;
  c.appendChild(t);
  setTimeout(() => {
    t.classList.add('exit');
    setTimeout(() => t.remove(), 200);
  }, duration);
}

function showModal({icon='ℹ️', iconBg='var(--primary-dim)', title='', text='', actions=[], html='', onClose}) {
  const o = document.getElementById('modal-overlay');
  o.classList.remove('hidden');
  const actionBtns = actions.map(a =>
    `<button class="btn ${a.style||'btn-primary'}" onclick="handleModalAction('${a.id||''}', ${a.close||false})">${a.label}</button>`
  ).join('');
  o.innerHTML = `<div class="modal">
    <div class="modal-icon" style="background:${iconBg}">${icon}</div>
    <h2 class="t-h2 t-center" style="margin-bottom:8px">${title}</h2>
    ${text ? `<p class="t-body t-muted t-center">${text}</p>` : ''}
    ${html}
    <div class="modal-actions">${actionBtns}</div>
  </div>`;
  o._onClose = onClose;
  o.addEventListener('click', function(e) {
    if (e.target === o) closeModal();
  }, {once:true});
}

function closeModal() {
  const o = document.getElementById('modal-overlay');
  o.classList.add('hidden');
  if (o._onClose) o._onClose();
}

window.handleModalAction = function(id, close) {
  if (window._modalCallbacks && window._modalCallbacks[id]) window._modalCallbacks[id]();
  if (close) closeModal();
};
window._modalCallbacks = {};

function confirmModal(title, text, icon, onConfirm) {
  window._modalCallbacks['confirm'] = onConfirm;
  showModal({
    icon, iconBg:'var(--danger-dim)', title, text,
    actions:[
      {label:'Cancelar', style:'btn-outline', close:true},
      {label:'Confirmar', style:'btn-danger', id:'confirm', close:true}
    ]
  });
}

function confetti() {
  const colors = ['#3D6EFF','#FF5E1A','#00D97E','#FFB020','#FF4757','#6B4EFF'];
  const c = document.createElement('div');
  c.className = 'confetti-container';
  document.body.appendChild(c);
  for (let i = 0; i < 60; i++) {
    const p = document.createElement('div');
    p.className = 'confetti-piece';
    const color = colors[Math.floor(Math.random()*colors.length)];
    const size  = Math.random()*8+6;
    const left  = Math.random()*100;
    const delay = Math.random()*0.8;
    const dur   = Math.random()*1.5+1.5;
    const shape = Math.random()>0.5 ? '50%' : '0';
    p.style.cssText = `left:${left}%;width:${size}px;height:${size}px;background:${color};
      border-radius:${shape};animation-duration:${dur}s;animation-delay:${delay}s`;
    c.appendChild(p);
  }
  setTimeout(() => c.remove(), 3000);
}

// ── AVATAR COM FOTO ──────────────────────────────────────────
function renderAvatar(profile, sizeClass, extra='') {
  const photo = profile?.photoBase64;
  if (photo) {
    return `<div class="avatar ${sizeClass} ${extra}" style="padding:0;overflow:hidden;background:transparent">
      <img src="${photo}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">
    </div>`;
  }
  return `<div class="avatar ${sizeClass} ${extra}">${getInitials(profile?.name||'?')}</div>`;
}
window.uploadArenaPhoto = function() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'image/*';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    showLoading();
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const img = new Image();
      img.onload = async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 800; canvas.height = 400;
        const ctx = canvas.getContext('2d');
        // Crop centralizado landscape
        const targetRatio = 2;
        const imgRatio = img.width / img.height;
        let sx=0, sy=0, sw=img.width, sh=img.height;
        if (imgRatio > targetRatio) {
          sw = img.height * targetRatio;
          sx = (img.width - sw) / 2;
        } else {
          sh = img.width / targetRatio;
          sy = (img.height - sh) / 2;
        }
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, 800, 400);
        const base64 = canvas.toDataURL('image/jpeg', 0.8);
        try {
          await db.collection('arenas').doc(App.arenaId).update({ photoBase64: base64 });
          App.arena = { ...App.arena, photoBase64: base64 };
          hideLoading();
          showToast('Foto da arena atualizada! ✅', 'success');
          App.go(SCREENS.A_SETTINGS);
        } catch(err) { hideLoading(); showToast('Erro ao salvar foto','error'); }
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  };
  input.click();
};

window.uploadProfilePhoto = function() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'image/*';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    showLoading();
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const img = new Image();
      img.onload = async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 200; canvas.height = 200;
        const ctx = canvas.getContext('2d');
        const minDim = Math.min(img.width, img.height);
        const sx = (img.width - minDim) / 2;
        const sy = (img.height - minDim) / 2;
        ctx.drawImage(img, sx, sy, minDim, minDim, 0, 0, 200, 200);
        const base64 = canvas.toDataURL('image/jpeg', 0.75);
        try {
          await db.collection('users').doc(App.user.uid).update({ photoBase64: base64 });
          if (App.arenaId) {
            await db.collection('arenas').doc(App.arenaId).collection('students')
              .doc(App.user.uid).update({ photoBase64: base64 }).catch(()=>{});
          }
          App.profile = { ...App.profile, photoBase64: base64 };
          hideLoading();
          showToast('Foto atualizada! ✅', 'success');
          App.go(SCREENS.S_PROFILE);
        } catch(err) { hideLoading(); showToast('Erro ao salvar foto','error'); }
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  };
  input.click();
};
function getInitials(name='') {
  return name.split(' ').slice(0,2).map(w=>w[0]).join('').toUpperCase();
}

function formatDate(ts) {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('pt-BR', {weekday:'short', day:'2-digit', month:'short'});
}

function formatTime(str) { return str; }

function timeAgo(ts) {
  if (!ts) return '';
  const now = Date.now();
  const d = ts.toDate ? ts.toDate().getTime() : new Date(ts).getTime();
  const diff = now - d;
  if (diff < 60000) return 'agora';
  if (diff < 3600000) return `${Math.floor(diff/60000)}min atrás`;
  if (diff < 86400000) return `${Math.floor(diff/3600000)}h atrás`;
  return `${Math.floor(diff/86400000)}d atrás`;
}

function pwdStrength(pwd) {
  let score = 0;
  if (pwd.length >= 8) score++;
  if (/[A-Z]/.test(pwd)) score++;
  if (/[0-9]/.test(pwd)) score++;
  if (/[^A-Za-z0-9]/.test(pwd)) score++;
  const labels = ['','Fraca','Regular','Boa','Forte'];
  const classes = ['','weak','fair','good','strong'];
  return {score, label:labels[score], css:classes[score]};
}

function validateEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }

// ── ROUTER ───────────────────────────────────────────────────
function renderScreen(screen, params) {
  const c = document.getElementById('screen-container');
  const renderers = {
    [SCREENS.SPLASH]:    screenSplash,
    [SCREENS.LOGIN]:     screenLogin,
    [SCREENS.REGISTER]:  screenRegister,
    [SCREENS.FORGOT]:    screenForgot,
    [SCREENS.INVITE]:    screenInvite,
    [SCREENS.S_HOME]:    screenStudentHome,
    [SCREENS.S_SCHEDULE]:screenStudentSchedule,
    [SCREENS.S_CLASSES]: screenStudentClasses,
    [SCREENS.S_NOTIFS]: screenStudentNotifs,
    [SCREENS.S_RANKING]: screenStudentRanking,
    [SCREENS.S_PROFILE]: screenStudentProfile,
    [SCREENS.A_HOME]:    screenAdminHome,
    [SCREENS.A_SCHEDULE]:screenAdminSchedule,
    [SCREENS.A_CLASS]:   screenAdminClass,
    [SCREENS.A_CREATE]:  screenAdminCreate,
    [SCREENS.A_STUDENTS]:screenAdminStudents,
    [SCREENS.A_STUDENT]: screenAdminStudentDetail,
    [SCREENS.A_REPORTS]: screenAdminReports,
    [SCREENS.A_SETTINGS]:screenAdminSettings,
    [SCREENS.SA_HOME]:   screenSAHome,
    [SCREENS.SA_ARENAS]: screenSAArenas,
    [SCREENS.SA_ARENA]:  screenSAArenaDetail,
    [SCREENS.SA_NEW_ARENA]:screenSANewArena,
    [SCREENS.SA_FINANCIAL]:screenSAFinancial,
    [SCREENS.SA_SETTINGS]:screenSASettings,
  };
  const fn = renderers[screen];
  if (fn) c.innerHTML = fn(params);
  else c.innerHTML = `<div class="screen empty-state"><div class="empty-emoji">🏗️</div><div class="empty-title">Em construção</div></div>`;
  attachListeners(screen, params);
}

function renderNav(screen) {
  const c = document.getElementById('bottom-nav-container');
  const noNav = [SCREENS.SPLASH, SCREENS.LOGIN, SCREENS.REGISTER, SCREENS.FORGOT, SCREENS.INVITE];
  if (noNav.includes(screen)) { c.innerHTML = ''; return; }
  const role = App.role;
  let items = [];
  if (role === 'student' || !role) {
    items = [
      {screen:SCREENS.S_HOME,     icon:'🏠', label:'Início'},
      {screen:SCREENS.S_SCHEDULE, icon:'📅', label:'Horários'},
      {screen:SCREENS.S_CLASSES,  icon:'📋', label:'Minhas Aulas'},
      {screen:SCREENS.S_RANKING,  icon:'🏆', label:'Ranking'},
      {screen:SCREENS.S_PROFILE,  icon:'👤', label:'Perfil'},
    ];
  } else if (role === 'arena_admin') {
    items = [
      {screen:SCREENS.A_HOME,     icon:'🏠', label:'Início'},
      {screen:SCREENS.A_SCHEDULE, icon:'📅', label:'Agenda'},
      {screen:SCREENS.A_STUDENTS, icon:'👥', label:'Alunos'},
      {screen:SCREENS.A_REPORTS,  icon:'📊', label:'Relatórios'},
      {screen:SCREENS.A_SETTINGS, icon:'⚙️', label:'Config'},
    ];
  } else if (role === 'superadmin') {
    items = [
      {screen:SCREENS.SA_HOME,      icon:'🏠', label:'Início'},
      {screen:SCREENS.SA_ARENAS,    icon:'🏟️', label:'Arenas'},
      {screen:SCREENS.SA_FINANCIAL, icon:'💰', label:'Financeiro'},
      {screen:SCREENS.SA_SETTINGS,  icon:'⚙️', label:'Config'},
    ];
  }
  c.innerHTML = `<nav class="bottom-nav">${
    items.map(i => `<button class="nav-item ${App.screen===i.screen?'active':''}" onclick="App.go('${i.screen}')">
      <span class="nav-icon">${i.icon}</span>
      <span class="nav-label">${i.label}</span>
    </button>`).join('')
  }</nav>`;
}

// ── ATTACH LISTENERS ─────────────────────────────────────────
function attachListeners(screen) {
  const AL = {
    [SCREENS.SPLASH]:    attachSplash,
    [SCREENS.LOGIN]:     attachLogin,
    [SCREENS.REGISTER]:  attachRegister,
    [SCREENS.FORGOT]:    attachForgot,
    [SCREENS.INVITE]:    attachInvite,
    [SCREENS.A_CREATE]:  attachAdminCreate,
    [SCREENS.A_SETTINGS]:attachAdminSettings,
    [SCREENS.SA_NEW_ARENA]:attachSANewArena,
  };
  if (AL[screen]) AL[screen]();

  // Live subscribe screens
  if (screen === SCREENS.S_HOME)    liveStudentHome();
  if (screen === SCREENS.S_SCHEDULE)liveStudentSchedule();
  if (screen === SCREENS.S_CLASSES) liveStudentClasses();
  if (screen === SCREENS.S_NOTIFS) loadNotifications();
  if (screen === SCREENS.S_RANKING) liveStudentRanking();
  if (screen === SCREENS.A_HOME)    liveAdminHome();
  if (screen === SCREENS.A_SCHEDULE)liveAdminSchedule();
  if (screen === SCREENS.A_CLASS)   liveAdminClass();
  if (screen === SCREENS.A_STUDENTS)liveAdminStudents();
  if (screen === SCREENS.A_STUDENT) liveAdminStudentDetail();
  if (screen === SCREENS.A_REPORTS) liveAdminReports();
  if (screen === SCREENS.SA_HOME)   liveSAHome();
  if (screen === SCREENS.SA_ARENAS) liveSAArenas();
  if (screen === SCREENS.SA_ARENA)  liveAdminStudents();
  if (screen === SCREENS.SA_FINANCIAL) liveSAFinancial();
}

// ═══════════════════════════════════════════════════════════
//  SPLASH SCREEN
// ═══════════════════════════════════════════════════════════
function screenSplash() {
  return `<div class="screen no-nav splash-screen">
    <div class="splash-logo">
      <div class="logo-mark">AF</div>
      <div class="logo-name">Arena<span>Flow</span></div>
      <div class="logo-tagline">Gestão inteligente de arenas</div>
    </div>
    <div class="splash-illustration">🏐</div>
    <div class="splash-actions">
      <button class="btn btn-primary btn-lg btn-full" id="btn-login">Entrar na minha conta</button>
     <button class="btn btn-outline btn-lg btn-full" id="btn-register">Criar conta de aluno</button>
      <button class="btn btn-ghost btn-full" id="btn-gestor" style="color:var(--text-2);font-size:14px">
        🏟️ Sou gestor de uma arena — tenho um código
      </button>
    </div>
  </div>`;
}
function attachSplash() {
 document.getElementById('btn-login')?.addEventListener('click', () => App.go(SCREENS.LOGIN));
  document.getElementById('btn-register')?.addEventListener('click', () => App.go(SCREENS.REGISTER));
  document.getElementById('btn-gestor')?.addEventListener('click', () => App.go(SCREENS.INVITE));
}

// ═══════════════════════════════════════════════════════════
//  LOGIN SCREEN
// ═══════════════════════════════════════════════════════════
function screenLogin() {
  return `<div class="screen no-nav auth-screen">
    <div class="auth-header">
      <button class="back-btn" onclick="App.go('${SCREENS.SPLASH}')">←</button>
      <br><br>
      <div class="logo-mark" style="width:52px;height:52px;font-size:22px;border-radius:16px;margin-bottom:16px">AF</div>
      <h1 class="t-h1">Bem-vindo de volta 👋</h1>
      <p class="t-body t-muted" style="margin-top:6px">Entre com seus dados para continuar</p>
    </div>
    <div class="auth-form">
      <div class="field">
        <label>E-mail</label>
        <div class="input-group">
          <input class="input" id="login-email" type="email" placeholder="seu@email.com" autocomplete="email">
          <span class="input-icon">✉️</span>
        </div>
      </div>
      <div class="field">
        <label>Senha</label>
        <div class="input-group">
          <input class="input" id="login-pwd" type="password" placeholder="Sua senha" autocomplete="current-password">
          <span class="input-icon" id="pwd-toggle" style="cursor:pointer">👁️</span>
        </div>
      </div>
      <button class="btn btn-primary btn-full btn-lg" id="btn-login-submit">Entrar</button>
      <button class="btn btn-outline btn-full" id="btn-biometric" style="gap:10px">
        <span>🔐</span> Entrar com Biometria
      </button>
      <div class="auth-footer">
        <a onclick="App.go('${SCREENS.FORGOT}')" style="cursor:pointer">Esqueci minha senha</a>
      </div>
    </div>
  </div>`;
}
function attachLogin() {
  const btnSubmit = document.getElementById('btn-login-submit');
  const toggle = document.getElementById('pwd-toggle');
  const pwd = document.getElementById('login-pwd');

  toggle?.addEventListener('click', () => {
    pwd.type = pwd.type === 'password' ? 'text' : 'password';
    toggle.textContent = pwd.type === 'password' ? '👁️' : '🙈';
  });

  document.getElementById('btn-biometric')?.addEventListener('click', loginBiometric);

  btnSubmit?.addEventListener('click', async () => {
    const email = document.getElementById('login-email')?.value.trim();
    const password = pwd?.value;
    if (!email || !validateEmail(email)) { showToast('Digite um e-mail válido', 'error'); return; }
    if (!password) { showToast('Digite sua senha', 'error'); return; }
    showLoading();
    try {
      await auth.signInWithEmailAndPassword(email, password);
      // onAuthStateChanged handles navigation
    } catch(e) {
      hideLoading();
      const msgs = {
        'auth/user-not-found': 'E-mail não encontrado',
        'auth/wrong-password': 'Senha incorreta',
        'auth/too-many-requests': 'Muitas tentativas. Tente mais tarde.',
        'auth/invalid-email': 'E-mail inválido'
      };
      showToast(msgs[e.code] || 'Erro ao entrar', 'error');
    }
  });

  // Enter key
  pwd?.addEventListener('keydown', e => {
    if (e.key === 'Enter') btnSubmit?.click();
  });
}

async function loginBiometric() {
  if (!window.PublicKeyCredential) {
    showToast('Biometria não disponível neste dispositivo', 'warning');
    return;
  }
  try {
    const stored = localStorage.getItem('af_biometric');
    if (!stored) {
      showToast('Configure a biometria no seu perfil primeiro', 'warning');
      return;
    }
    const {email, password} = JSON.parse(atob(stored));
    showLoading();
    const available = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    if (!available) { hideLoading(); showToast('Biometria não disponível', 'warning'); return; }
    // Trigger biometric prompt via WebAuthn get
    await navigator.credentials.get({
      publicKey: {
        challenge: new Uint8Array(32),
        timeout: 60000,
        userVerification: 'required'
      }
    }).catch(() => null);
    await auth.signInWithEmailAndPassword(email, password);
  } catch(e) {
    hideLoading();
    showToast('Falha na biometria', 'error');
  }
}

// ═══════════════════════════════════════════════════════════
//  REGISTER SCREEN (multi-step)
// ═══════════════════════════════════════════════════════════
let regData = {};
let regStep = 1;

function screenRegister() {
  regStep = 1; regData = {};
  return `<div class="screen no-nav auth-screen">
    <div class="auth-header">
      <button class="back-btn" id="reg-back">←</button>
      <br><br>
      <div class="step-indicator">
        <div class="step-dot active" id="sd1"></div>
        <div class="step-dot" id="sd2"></div>
        <div class="step-dot" id="sd3"></div>
      </div>
      <h1 class="t-h1" id="reg-title">Qual é o seu nome?</h1>
      <p class="t-body t-muted" id="reg-sub" style="margin-top:6px">Etapa 1 de 3 — Dados pessoais</p>
    </div>
    <div class="auth-form" id="reg-form-content">
      ${regFormStep1()}
    </div>
    <div style="padding:20px 24px">
      <button class="btn btn-primary btn-full btn-lg" id="reg-next">Continuar →</button>
      <div class="auth-footer" style="margin-top:12px">
        Já tem conta? <a onclick="App.go('${SCREENS.LOGIN}')" style="cursor:pointer">Entrar</a>
      </div>
      <div id="student-code-section" style="display:none;margin-top:16px">
        <div class="field">
          <label>Código da arena (opcional)</label>
          <input class="input" id="reg-arena-code" type="text" placeholder="Ex: AJJ123"
            maxlength="6" style="text-transform:uppercase;letter-spacing:4px;font-size:18px;font-weight:700;text-align:center">
          <span class="input-hint">Peça o código para o gestor da sua arena</span>
        </div>
      </div>
    </div>
  </div>`;
}

function regFormStep1() {
  return `<div class="field">
    <label>Nome completo</label>
    <input class="input" id="reg-name" type="text" placeholder="Seu nome completo" autocomplete="name">
  </div>
  <div class="field">
    <label>E-mail</label>
    <input class="input" id="reg-email" type="email" placeholder="seu@email.com" autocomplete="email">
  </div>
  <div class="field">
    <label>Código da arena (opcional)</label>
    <input class="input" id="reg-arena-code" type="text" placeholder="Ex: AJJ123"
      maxlength="6" style="text-transform:uppercase;letter-spacing:4px;font-size:18px;font-weight:700;text-align:center">
    <span class="input-hint">Peça o código para o gestor da sua arena</span>
  </div>`;
}
function regFormStep2() {
  return `<div class="field">
    <label>Idade</label>
    <input class="input" id="reg-age" type="number" placeholder="Sua idade" min="10" max="90">
  </div>
  <div class="field">
    <label>Sexo</label>
    <select class="input" id="reg-sex">
      <option value="">Selecione...</option>
      <option value="M">Masculino</option>
      <option value="F">Feminino</option>
      <option value="O">Prefiro não informar</option>
    </select>
  </div>`;
}
function regFormStep3() {
  return `<div class="field">
    <label>Senha</label>
    <div class="input-group">
      <input class="input" id="reg-pwd" type="password" placeholder="Crie uma senha segura">
      <span class="input-icon" id="reg-pwd-toggle" style="cursor:pointer">👁️</span>
    </div>
    <div class="pwd-strength" id="pwd-bars">
      <div class="pwd-bar" id="pb1"></div><div class="pwd-bar" id="pb2"></div>
      <div class="pwd-bar" id="pb3"></div><div class="pwd-bar" id="pb4"></div>
    </div>
    <span class="input-hint" id="pwd-strength-label">Mínimo 8 chars, 1 maiúscula, 1 número, 1 símbolo</span>
  </div>
  <div class="field">
    <label>Confirmar senha</label>
    <div class="input-group">
      <input class="input" id="reg-pwd2" type="password" placeholder="Repita a senha">
    </div>
  </div>`;
}

function attachRegister() {
  const stepTitles = ['','Qual é o seu nome?','Sobre você','Crie sua senha'];
  const stepSubs   = ['','Etapa 1 de 3 — Dados pessoais','Etapa 2 de 3 — Perfil','Etapa 3 de 3 — Segurança'];

  document.getElementById('reg-back')?.addEventListener('click', () => {
    if (regStep === 1) { App.go(SCREENS.SPLASH); return; }
    regStep--;
    updateRegStep(stepTitles, stepSubs);
  });

  document.getElementById('reg-next')?.addEventListener('click', () => {
    if (!validateRegStep()) return;
    if (regStep < 3) {
      regStep++;
      updateRegStep(stepTitles, stepSubs);
    } else {
      submitRegister();
    }
  });
}

function updateRegStep(titles, subs) {
  document.getElementById('reg-title').textContent = titles[regStep];
  document.getElementById('reg-sub').textContent = subs[regStep];
  document.getElementById('reg-next').textContent = regStep < 3 ? 'Continuar →' : 'Criar conta';
  for (let i=1;i<=3;i++) {
    const dot = document.getElementById(`sd${i}`);
    dot.className = 'step-dot' + (i < regStep ? ' complete' : i === regStep ? ' active' : '');
  }
  const fc = document.getElementById('reg-form-content');
  fc.innerHTML = [regFormStep1,regFormStep2,regFormStep3][regStep-1]();
  const codeSection = document.getElementById('student-code-section');
  if (codeSection) codeSection.style.display = regStep === 3 ? 'block' : 'none';

  if (regStep === 1) {
    document.getElementById('reg-name').value = regData.name || '';
    document.getElementById('reg-email').value = regData.email || '';
  }
  if (regStep === 3) {
    document.getElementById('reg-pwd')?.addEventListener('input', () => {
      const v = document.getElementById('reg-pwd').value;
      const s = pwdStrength(v);
      ['pb1','pb2','pb3','pb4'].forEach((id,i) => {
        document.getElementById(id).className = `pwd-bar ${i < s.score ? s.css : ''}`;
      });
      document.getElementById('pwd-strength-label').textContent = s.score ? `Senha ${s.label}` : 'Mínimo 8 chars, 1 maiúscula, 1 número, 1 símbolo';
      document.getElementById('pwd-strength-label').style.color = s.score < 3 ? 'var(--warning)' : 'var(--success)';
    });
    document.getElementById('reg-pwd-toggle')?.addEventListener('click', () => {
      const p = document.getElementById('reg-pwd');
      p.type = p.type === 'password' ? 'text' : 'password';
    });
  }
}

function validateRegStep() {
  if (regStep === 1) {
    const name = document.getElementById('reg-name')?.value.trim();
    const email = document.getElementById('reg-email')?.value.trim();
    const arenaCode = document.getElementById('reg-arena-code')?.value?.trim().toUpperCase() || '';
    if (!name || name.split(' ').length < 2) { showToast('Digite seu nome completo', 'error'); return false; }
    if (!validateEmail(email)) { showToast('Digite um e-mail válido', 'error'); return false; }
    regData.name = name; regData.email = email;
    regData.arenaCode = arenaCode || null;
  }
  if (regStep === 2) {
    const age = parseInt(document.getElementById('reg-age')?.value);
    const sex = document.getElementById('reg-sex')?.value;
    if (!age || age < 10 || age > 90) { showToast('Digite uma idade válida', 'error'); return false; }
    if (!sex) { showToast('Selecione o sexo', 'error'); return false; }
    regData.age = age; regData.sex = sex;
  }
  if (regStep === 3) {
    const pwd = document.getElementById('reg-pwd')?.value;
    const pwd2 = document.getElementById('reg-pwd2')?.value;
    const s = pwdStrength(pwd);
    if (s.score < 3) { showToast('Senha muito fraca. Adicione maiúscula, número e símbolo', 'error'); return false; }
    if (pwd !== pwd2) { showToast('As senhas não coincidem', 'error'); return false; }
    regData.password = pwd;
  }
  return true;
}
async function submitRegister() {
  showLoading();
  try {
    const cred = await auth.createUserWithEmailAndPassword(regData.email, regData.password);
    await cred.user.updateProfile({ displayName: regData.name });
    const arenaCode = document.getElementById('reg-arena-code')?.value.trim().toUpperCase();
    await db.collection('users').doc(cred.user.uid).set({
      name: regData.name, email: regData.email,
      age: regData.age, sex: regData.sex,
      role: 'student', arenaId: null,
      totalClasses: 0, monthClasses: 0,
      streak: 0, streakWeeks: 0,
      badges: ['first'], reactions: 0, referrals: 0,
      waitlistWent: 0, fastConfirms: 0,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    // Vincula à arena: users.arenaId + doc em /students (Rules validam)
    if (arenaCode) {
      const arenaSnap = await db.collection('arenas')
        .where('studentCode','==',arenaCode).limit(1).get().catch(()=>null);
      if (arenaSnap && !arenaSnap.empty) {
        const arenaId = arenaSnap.docs[0].id;
        await db.collection('users').doc(cred.user.uid).update({ arenaId }).catch(()=>{});
        await ensureStudentDoc(arenaId, cred.user.uid, {
          name: regData.name, email: regData.email, badges:['first']
        });
      } else {
        showToast('Código da arena inválido — cadastro feito sem arena','warning');
      }
    }
    hideLoading();
    confetti();
    showModal({
      icon:'🎉', iconBg:'var(--success-dim)',
      title:'Conta criada!',
      text:`Bem-vindo ao ArenaFlow, ${regData.name.split(' ')[0]}! 🏐`,
      actions:[{label:'Começar agora!', style:'btn-success', close:true}],
      onClose: () => App.go(SCREENS.S_HOME)
    });
  } catch(e) {
    hideLoading();
    const msgs = { 'auth/email-already-in-use':'E-mail já cadastrado', 'auth/weak-password':'Senha muito fraca' };
    showToast(msgs[e.code] || 'Erro ao criar conta', 'error');
  }
}

// ═══════════════════════════════════════════════════════════
//  FORGOT PASSWORD
// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════
//  TELA DE CÓDIGO DE CONVITE (Gestor)
// ═══════════════════════════════════════════════════════════
function screenInvite() {
  return `<div class="screen no-nav auth-screen">
    <div class="auth-header">
      <button class="back-btn" onclick="App.go('${SCREENS.SPLASH}')">←</button>
      <br><br>
      <div style="font-size:52px;margin-bottom:16px">🔑</div>
      <h1 class="t-h1">Código de convite</h1>
      <p class="t-body t-muted" style="margin-top:6px">
        Digite o código de 6 dígitos que o responsável pelo ArenaFlow enviou para você
      </p>
    </div>
    <div class="auth-form">
      <div class="field">
        <label>Seu e-mail</label>
        <input class="input" id="inv-email" type="email" placeholder="seu@email.com">
      </div>
      <div class="field">
        <label>Senha</label>
        <div class="input-group">
          <input class="input" id="inv-pwd" type="password" placeholder="Sua senha">
        </div>
      </div>
      <div class="field">
        <label>Código de convite</label>
        <input class="input" id="inv-code" type="text" placeholder="Ex: AB3X7K"
          maxlength="6" style="text-transform:uppercase;letter-spacing:6px;
          font-size:22px;font-weight:800;text-align:center">
      </div>
      <p class="t-xs t-muted t-center">
        Não tem conta ainda? Crie normalmente com "Criar conta de aluno" e depois use o código
      </p>
      <button class="btn btn-primary btn-full btn-lg" id="btn-invite-submit">
        🏟️ Entrar como Gestor
      </button>
      <div class="auth-footer">
        <a onclick="App.go('${SCREENS.SPLASH}')" style="cursor:pointer">← Voltar</a>
      </div>
    </div>
  </div>`;
}

function attachInvite() {
  document.getElementById('inv-code')?.addEventListener('input', function() {
    this.value = this.value.toUpperCase();
  });

  document.getElementById('btn-invite-submit')?.addEventListener('click', async () => {
    const email = document.getElementById('inv-email')?.value.trim();
    const pwd   = document.getElementById('inv-pwd')?.value;
    const code  = document.getElementById('inv-code')?.value.trim().toUpperCase();

    if (!email || !validateEmail(email)) { showToast('E-mail inválido','error'); return; }
    if (!pwd) { showToast('Digite sua senha','error'); return; }
    if (code.length !== 6) { showToast('Código deve ter 6 caracteres','error'); return; }
    showLoading();
    try {
      const arenaSnap = await db.collection('arenas')
        .where('inviteCode','==',code).limit(1).get();
      if (arenaSnap.empty) {
        hideLoading();
        showToast('Código inválido ou expirado','error');
        return;
      }
      const arenaDoc = arenaSnap.docs[0];
      const arenaId  = arenaDoc.id;
      const arena    = arenaDoc.data();
      // Trava 1: só o e-mail cadastrado pelo responsável resgata o convite
      if ((arena.gestorEmail || '').toLowerCase() !== email.toLowerCase()) {
        hideLoading();
        showToast('Este convite pertence a outro e-mail. Fale com o suporte ArenaFlow.','error');
        return;
      }
      let userCred;
      try {
        userCred = await auth.signInWithEmailAndPassword(email, pwd);
      } catch(e) {
        if (e.code === 'auth/user-not-found') {
          userCred = await auth.createUserWithEmailAndPassword(email, pwd);
        } else { throw e; }
      }
      const uid = userCred.user.uid;
      // Trava 2: uso único — primeiro resgate grava gestorUid (Rules validam)
      if (arena.gestorUid && arena.gestorUid !== uid) {
        hideLoading();
        showToast('Este convite já foi utilizado.','error');
        return;
      }
      await db.collection('users').doc(uid).set({
        email, role: 'arena_admin', arenaId, adminLevel: 'owner',
        name: arena.gestorName || email.split('@')[0],
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      if (!arena.gestorUid) {
        await db.collection('arenas').doc(arenaId).update({ gestorUid: uid }).catch(()=>{});
      }
      hideLoading();
      confetti();
      showModal({
        icon:'🏟️', iconBg:'var(--success-dim)',
        title:'Bem-vindo, Gestor!',
        text:`Você foi vinculado à ${arena.name} com sucesso!`,
        actions:[{label:'Abrir painel', style:'btn-success', close:true}],
        onClose: () => App.loadUserProfile(uid)
      });
    } catch(e) {
      hideLoading();
      const msgs = {
        'auth/wrong-password':'Senha incorreta',
        'auth/invalid-email':'E-mail inválido',
        'auth/weak-password':'Senha fraca — mínimo 6 caracteres'
      };
      showToast(msgs[e.code] || 'Erro: ' + e.message,'error');
    }
  });
}
function screenForgot() {
  return `<div class="screen no-nav auth-screen">
    <div class="auth-header">
      <button class="back-btn" onclick="App.go('${SCREENS.LOGIN}')">←</button>
      <br><br>
      <div style="font-size:48px;margin-bottom:16px">🔑</div>
      <h1 class="t-h1">Recuperar senha</h1>
      <p class="t-body t-muted" style="margin-top:6px">Enviaremos um link de redefinição para o seu e-mail</p>
    </div>
    <div class="auth-form">
      <div class="field">
        <label>E-mail cadastrado</label>
        <div class="input-group">
          <input class="input" id="forgot-email" type="email" placeholder="seu@email.com">
          <span class="input-icon">✉️</span>
        </div>
      </div>
      <button class="btn btn-primary btn-full btn-lg" id="btn-forgot">Enviar link de recuperação</button>
      <div class="auth-footer">
        <a onclick="App.go('${SCREENS.LOGIN}')" style="cursor:pointer">← Voltar ao login</a>
      </div>
    </div>
  </div>`;
}
function attachForgot() {
  document.getElementById('btn-forgot')?.addEventListener('click', async () => {
    const email = document.getElementById('forgot-email')?.value.trim();
    if (!validateEmail(email)) { showToast('Digite um e-mail válido', 'error'); return; }
    showLoading();
    try {
      await auth.sendPasswordResetEmail(email);
      hideLoading();
      showModal({
        icon:'📧', iconBg:'var(--success-dim)',
        title:'E-mail enviado!',
        text:'Verifique sua caixa de entrada e siga as instruções para redefinir sua senha.',
        actions:[{label:'OK', style:'btn-primary', close:true}],
        onClose: () => App.go(SCREENS.LOGIN)
      });
    } catch(e) {
      hideLoading();
      showToast('E-mail não encontrado', 'error');
    }
  });
}

// ═══════════════════════════════════════════════════════════
//  STUDENT — HOME
// ═══════════════════════════════════════════════════════════
function screenStudentHome() {
  const p = App.profile || {};
  const firstName = (p.name||'Aluno').split(' ')[0];
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';
  return `<div class="screen">
   <div class="home-hero" style="${App.arena?.photoBase64 ? 'background-image:linear-gradient(to bottom,rgba(7,7,17,0.55),rgba(7,7,17,0.92)),url(' + JSON.stringify(App.arena.photoBase64) + ');background-size:cover;background-position:center;' : 'background:linear-gradient(160deg,rgba(61,110,255,0.12) 0%,transparent 60%),linear-gradient(220deg,rgba(255,94,26,0.08) 0%,transparent 60%);'}">
      <div class="flex items-center justify-between">
        <div class="home-greeting">
          <small>${greeting},</small>${firstName} 👋
        </div>
        <div class="flex items-center" style="gap:14px">
          <div onclick="App.go('${SCREENS.S_NOTIFS}')" style="position:relative;font-size:24px;cursor:pointer;line-height:1">🔔<span id="notif-badge" style="display:none;position:absolute;top:-5px;right:-8px;background:var(--danger,#ff4d4d);color:#fff;font-size:10px;font-weight:800;border-radius:9px;padding:1px 5px;min-width:16px;text-align:center"></span></div>
          <div onclick="App.go('${SCREENS.S_PROFILE}')">${renderAvatar(p,'avatar-md')}</div>
        </div>
      </div>
      <div class="grid-2" style="margin-top:16px" id="home-stats">
        <div class="stat-card primary"><div class="stat-value" id="st-month">—</div><div class="stat-label">Aulas este mês</div></div>
        <div class="stat-card success"><div class="stat-value" id="st-streak">—</div><div class="stat-label">Semanas seguidas</div></div>
      </div>
    </div>
    <div class="section-header">
      <span class="section-title">⏰ Próxima aula</span>
      <span class="section-action" onclick="App.go('${SCREENS.S_SCHEDULE}')">Ver tudo</span>
    </div>
    <div id="next-class-container" style="padding:0 20px 8px">
      <div class="card t-muted t-center" style="padding:24px">Carregando...</div>
    </div>
    <div class="section-header" style="margin-top:8px">
      <span class="section-title">🏆 Ranking do mês</span>
      <span class="section-action" onclick="App.go('${SCREENS.S_RANKING}')">Ver completo</span>
    </div>
    <div id="mini-ranking" style="padding:0 20px 8px">
      <div class="card t-muted t-center" style="padding:24px">Carregando...</div>
    </div>
    <div class="section-header" style="margin-top:8px">
      <span class="section-title">🏅 Últimos emblemas</span>
      <span class="section-action" onclick="App.go('${SCREENS.S_PROFILE}')">Ver todos</span>
    </div>
    <div id="mini-badges" style="padding:0 20px"></div>
  </div>`;
}

function liveStudentHome() {
  refreshNotifBadge();
  if (!App.user || !App.arenaId) return;
  const uid = App.user.uid;
  const arenaId = App.arenaId;

  // Live profile stats
  const unsub1 = db.collection('users').doc(uid).onSnapshot(snap => {
    if (!snap.exists) return;
    const d = snap.data();
    App.profile = d;
    const m = document.getElementById('st-month');
    const s = document.getElementById('st-streak');
    if (m) m.textContent = d.monthClasses || 0;
    if (s) s.textContent = `${d.streakWeeks || 0}🔥`;

    // Mini badges
    const earned = (d.badges || []);
    const last3 = BADGES.filter(b => earned.includes(b.id)).slice(-3);
    const mb = document.getElementById('mini-badges');
    if (mb) mb.innerHTML = last3.length ? `<div class="flex gap-8" style="flex-wrap:wrap">${
      last3.map(b=>`<div class="badge-item earned" style="flex:1;min-width:80px">
        <span class="badge-emoji">${b.emoji}</span>
        <span class="badge-name">${b.name}</span>
      </div>`).join('')
    }</div>` : `<p class="t-sm t-muted" style="padding:0 0 8px">Participe de aulas para ganhar emblemas!</p>`;
  });
  App.unsubscribers.push(unsub1);

  // Next class
  const now = firebase.firestore.Timestamp.now();
  const unsub2 = db.collection('arenas').doc(arenaId).collection('classes')
    .where('status','in',['open','confirmed'])
    .orderBy('startTimestamp')
    .startAt(now)
    .limit(1)
    .onSnapshot(snap => {
      const nc = document.getElementById('next-class-container');
      if (!nc) return;
      if (snap.empty) {
        nc.innerHTML = `<div class="card" style="padding:24px;text-align:center">
          <div style="font-size:32px;margin-bottom:8px">📭</div>
          <p class="t-sm t-muted">Nenhuma aula agendada em breve</p>
        </div>`;
        return;
      }
      const cls = snap.docs[0].data();
      const clsId = snap.docs[0].id;
      // Check enrollment
      db.collection('arenas').doc(arenaId).collection('classes').doc(clsId)
        .collection('enrollments').doc(uid).get().then(es => {
          const st = es.exists ? es.data().status : null;
          const pct = Math.round((cls.spotsUsed||0)/(cls.maxSpots||1)*100);
          const barClass = pct>=90?'low':pct>=60?'medium':'high';
          nc.innerHTML = `<div class="class-card status-${getClassStatus(cls)}" onclick="App.go('${SCREENS.S_SCHEDULE}')">
            <div class="flex items-center justify-between">
              <div>
                <div class="t-h3">${cls.modality||'Futevôlei'}</div>
                <div class="t-sm t-muted">${formatDate(cls.startTimestamp)} • ${cls.startTime}–${cls.endTime}</div>
              </div>
              ${st ? `<span class="status-pill ${STATUS_CSS[st]||''}">${STATUS_LABELS[st]||st}</span>` : `<button class="btn btn-primary btn-sm" onclick="event.stopPropagation();enrollClass('${clsId}')">Participar</button>`}
            </div>
            <div class="spots-bar" style="margin-top:10px">
              <div class="spots-fill ${barClass}" style="width:${pct}%"></div>
            </div>
            <div class="t-xs t-muted" style="margin-top:6px">${cls.spotsUsed||0}/${cls.maxSpots} vagas preenchidas</div>
          </div>`;
        });
    });
  App.unsubscribers.push(unsub2);

  // Mini ranking (top 3)
  const month = new Date().toISOString().slice(0,7);
  db.collection('arenas').doc(arenaId).collection('rankings').doc(month)
    .collection('scores').orderBy('monthClasses','desc').limit(3).get().then(snap => {
      const mr = document.getElementById('mini-ranking');
      if (!mr) return;
      if (snap.empty) { mr.innerHTML = `<div class="card t-muted t-center" style="padding:20px">Ranking ainda sem dados</div>`; return; }
      mr.innerHTML = `<div class="card" style="padding:0;overflow:hidden">${
        snap.docs.map((d,i) => {
          const data = d.data();
          const medals = ['🥇','🥈','🥉'];
          return `<div class="flex items-center gap-12" style="padding:12px 16px;border-bottom:1px solid var(--border);${i===2?'border:none':''}">
            <span style="font-size:20px">${medals[i]}</span>
            <div class="avatar avatar-sm">${getInitials(data.name||'?')}</div>
            <span class="t-h3 flex-1">${data.name||'—'}</span>
            <span class="badge badge-primary">${data.monthClasses||0} aulas</span>
          </div>`;
        }).join('')
      }</div>`;
    });
}

function getClassStatus(cls) {
  const used = cls.spotsUsed || 0;
  const max  = cls.maxSpots || 1;
  const pct  = used/max;
  if (cls.waitlist?.length > 0) return 'waitlist';
  if (pct >= 1) return 'full';
  if (pct >= 0.8) return 'few';
  return 'open';
}

// ═══════════════════════════════════════════════════════════
//  STUDENT — SCHEDULE
// ═══════════════════════════════════════════════════════════
function screenStudentSchedule() {
  const days = getWeekDays();
  return `<div class="screen">
    <div class="topbar"><span class="topbar-title">📅 Horários</span></div>
    <div class="week-strip" id="week-strip">
      ${days.map((d,i) => `<div class="day-pill ${i===0?'active':''}" data-date="${d.iso}" onclick="selectDay('${d.iso}',this)">
        <span class="day-name">${d.name}</span>
        <span class="day-num">${d.num}</span>
        <div class="day-dot"></div>
      </div>`).join('')}
    </div>
    <div class="chip-row">
      <div class="chip active" data-mod="all" onclick="filterMod('all',this)">Todos</div>
      <div class="chip" data-mod="Futevôlei" onclick="filterMod('Futevôlei',this)">Futevôlei</div>
      <div class="chip" data-mod="Vôlei" onclick="filterMod('Vôlei',this)">Vôlei</div>
      <div class="chip" data-mod="Beach Tennis" onclick="filterMod('Beach Tennis',this)">Beach Tennis</div>
    </div>
    <div id="classes-list" style="padding:0 20px;display:flex;flex-direction:column;gap:10px">
      <div class="empty-state"><div class="empty-emoji">⌛</div><div class="t-muted">Carregando...</div></div>
    </div>
  </div>`;
}
window.selectDay = function(date, el) {
  document.querySelectorAll('.day-pill').forEach(d => d.classList.remove('active'));
  el.classList.add('active');
  loadClassesForDay(date);
};
window.filterMod = function(mod, el) {
  document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  window._currentMod = mod;
  window._currentDay && loadClassesForDay(window._currentDay);
};

function liveStudentSchedule() {
  const days = getWeekDays();
  window._currentDay = days[0].iso;
  window._currentMod = 'all';
  loadClassesForDay(days[0].iso);
}

function loadClassesForDay(dateStr) {
  window._currentDay = dateStr;
  if (!App.arenaId) return;
  const list = document.getElementById('classes-list');
  if (!list) return;
  list.innerHTML = `<div class="empty-state"><div class="empty-emoji">⌛</div></div>`;
  let q = db.collection('arenas').doc(App.arenaId).collection('classes')
    .where('dateStr','==',dateStr);
  if (window._currentMod && window._currentMod !== 'all') {
    q = q.where('modality','==',window._currentMod);
  }
  q.get().then(snap => {
    if (!list) return;
    let docs = snap.docs.sort((a,b) => a.data().startTime.localeCompare(b.data().startTime));
    // Aula cancelada some da agenda do aluno
    docs = docs.filter(d => d.data().status !== 'cancelled');
    // Habilitação por NÍVEL: o aluno vê as aulas do seu nível + "todos"
    const studentNivel = App.profile?.nivel;
    docs = docs.filter(d => nivelMatches(d.data().nivel, studentNivel));
    if (docs.length === 0) {
      const msg = !studentNivel
        ? `<div class="empty-state"><div class="empty-emoji">🎯</div>
            <div class="empty-title">Aguardando seu nível</div>
            <div class="empty-text">O gestor ainda vai definir seu nível — depois disso suas aulas aparecem aqui.</div></div>`
        : `<div class="empty-state"><div class="empty-emoji">🏖️</div>
            <div class="empty-title">Sem aulas neste dia</div></div>`;
      list.innerHTML = msg;
      return;
    }
    renderClassCards(docs, list);
  });
}

function renderClassCards(docs, container) {
  const uid = App.user?.uid;
  const promises = docs.map(doc => {
    const cls = doc.data();
    const clsId = doc.id;
    if (!uid) return Promise.resolve({cls,clsId,status:null});
    return db.collection('arenas').doc(App.arenaId).collection('classes')
      .doc(clsId).collection('enrollments').doc(uid).get()
      .then(es => ({cls, clsId, status: es.exists ? es.data().status : null, waitPos: es.data?.()?.waitlistPosition}));
  });
  Promise.all(promises).then(items => {
    container.innerHTML = items.map(({cls,clsId,status,waitPos}) => {
      const pct = Math.round((cls.spotsUsed||0)/(cls.maxSpots||1)*100);
      const barC = pct>=90?'low':pct>=60?'medium':'high';
      const cardStatus = getClassStatus(cls);
      const isPast = cls.startTimestamp && cls.startTimestamp.toDate() < new Date();
      let actionBtn = '';
      if (!isPast) {
        if (!status || status === 'cancelled') {
          const tipo = App.profile?.tipo || 'avulso';
          const minHours = getEnrollWindowHours(tipo);
          const clsDateTime = new Date(`${cls.dateStr}T${cls.startTime}`);
          const hoursUntil = (clsDateTime - new Date()) / (1000 * 60 * 60);
          if (hoursUntil > minHours) {
            const hoursLeft = Math.floor(hoursUntil - minHours);
            const minsLeft = Math.floor(((hoursUntil - minHours) % 1) * 60);
            actionBtn = `<div class="t-center">
              <div class="t-xs t-muted">${tipo==='mensalista'?'⭐':'🎫'} Abre em</div>
              <div style="font-size:13px;font-weight:700;color:var(--warning)">${hoursLeft}h ${minsLeft}min</div>
            </div>`;
          } else {
            actionBtn = `<button class="btn btn-primary btn-sm" onclick="event.stopPropagation();enrollClass('${clsId}')">Participar</button>`;
          }
        } else if (status === 'waitlist') {
          actionBtn = `<span class="status-pill status-waitlist">Fila #${waitPos||'?'}</span>`;
        } else {
          actionBtn = `<span class="status-pill ${STATUS_CSS[status]||''}">${STATUS_LABELS[status]||status}</span>`;
        }
      }
      return `<div class="class-card status-${cardStatus}${isPast?' status-past':''}">
        <div class="flex items-center justify-between">
          <div>
            <div class="t-h3">${cls.modality||'Futevôlei'}</div>
            <div class="t-sm t-muted" style="margin-top:2px">${cls.startTime} – ${cls.endTime}${cls.court?` • ${cls.court}`:''}</div>
          </div>
          ${actionBtn}
        </div>
        <div class="spots-bar">
          <div class="spots-fill ${barC}" style="width:${Math.min(pct,100)}%"></div>
        </div>
        <div class="flex items-center justify-between" style="margin-top:6px">
          <span class="t-xs t-muted">${cls.spotsUsed||0}/${cls.maxSpots} vagas</span>
          ${cls.waitlist?.length ? `<span class="t-xs" style="color:var(--accent)">${cls.waitlist.length} na fila</span>` : ''}
        </div>
      </div>`;
    }).join('');
  });
}

window.enrollClass = async function(clsId) {
  if (!App.user || !App.arenaId) return;
  const uid = App.user.uid;
  const clsRef = db.collection('arenas').doc(App.arenaId).collection('classes').doc(clsId);
  const enrRef = clsRef.collection('enrollments').doc(uid);

  showLoading();
  try {
    // Garante o vínculo (auto-reparo) e lê dados do aluno
    await ensureStudentDoc(App.arenaId, uid, App.profile);
    const stSnap = await db.collection('arenas').doc(App.arenaId)
      .collection('students').doc(uid).get();
    const student = stSnap.exists ? stSnap.data() : {};
    if (student.status === 'blocked') {
      hideLoading();
      showModal({ icon:'⛔', iconBg:'var(--danger-dim)', title:'Acesso bloqueado',
        text:'Fale com o gestor da arena.', actions:[{label:'OK', style:'btn-outline', close:true}] });
      return;
    }

    const clsSnap0 = await clsRef.get();
    if (!clsSnap0.exists) throw new Error('Aula não encontrada');
    const cls0 = clsSnap0.data();

    // Habilitação por nível
    if (!nivelMatches(cls0.nivel, student.nivel)) {
      hideLoading();
      const nomes = {iniciante:'Iniciante', intermediario:'Intermediário', avancado:'Avançado',
        intermediario_avancado:'Intermediário/Avançado', feminino:'Feminino'};
      showModal({ icon:'🎯', iconBg:'var(--danger-dim)', title:'Aula de outro nível',
        text: student.nivel
          ? `Esta turma é ${nomes[cls0.nivel]||cls0.nivel}. Seu nível é ${nomes[student.nivel]||student.nivel}. Fale com o gestor se acha que deveria participar.`
          : 'O gestor ainda não definiu seu nível. Fale com ele para liberar suas aulas.',
        actions:[{label:'Entendi', style:'btn-outline', close:true}] });
      return;
    }

    // Janela por tipo (também imposta pelas Security Rules no servidor)
    const tipo = student.tipo || 'avulso';
    const minHours = getEnrollWindowHours(tipo);
    const startsAt = new Date(`${cls0.dateStr}T${cls0.startTime}`);
    const hoursUntil = (startsAt - new Date()) / 3600000;
    if (hoursUntil <= 0) {
      hideLoading();
      showToast('Esta aula já começou','warning');
      return;
    }
    if (hoursUntil > minHours) {
      const mins = Math.ceil((hoursUntil - minHours) * 60);
      hideLoading();
      showModal({
        icon: tipo === 'mensalista' ? '⭐' : '🎫', iconBg:'var(--warning-dim)',
        title:'Ainda não liberado',
        text:`${tipo === 'mensalista' ? 'Mensalistas' : 'Avulsos'} podem se inscrever a partir de ${minHours}h antes da aula. Abre em ${Math.floor(mins/60)}h ${mins%60}min.`,
        actions:[{label:'Entendi', style:'btn-outline', close:true}]
      });
      return;
    }

    const result = await db.runTransaction(async t => {
      const [fSnap, eSnap] = await Promise.all([t.get(clsRef), t.get(enrRef)]);
      const fd = fSnap.data();
      if (!fd) throw new Error('Aula removida');
      if (fd.status === 'cancelled') throw new Error('Esta aula foi cancelada pela arena');

      // Sem duplicidade (toque duplo, console etc.)
      if (eSnap.exists) {
        const st = eSnap.data().status;
        if (st === 'invited' || st === 'confirmed') throw new Error('Você já está inscrito nesta aula');
        if (st === 'waitlist') throw new Error(`Você já está na fila (posição #${eSnap.data().waitlistPosition||'?'})`);
        // cancelled → pode reinscrever
      }

      const waitlist = fd.waitlist || [];
      const used = fd.spotsUsed || 0;
      const max  = fd.maxSpots || 0;
      const base = {
        studentId: uid,
        studentName: App.profile?.name || '',
        enrolledAt: firebase.firestore.FieldValue.serverTimestamp(),
        // denormalização: conserta a tela "Minhas Aulas"
        modality: fd.modality || 'Futevôlei',
        dateStr: fd.dateStr || null,
        startTime: fd.startTime || null,
        endTime: fd.endTime || null,
        court: fd.court || null,
        startTimestamp: fd.startTimestamp || null
      };

      // FILA JUSTA: vaga direta só se há vaga E ninguém esperando
      if (used < max && waitlist.length === 0) {
        t.set(enrRef, { ...base, status:'invited',
          waitlistPosition: firebase.firestore.FieldValue.delete() }, { merge:true });
        t.update(clsRef, { spotsUsed: used + 1 });
        return { status:'enrolled' };
      }
      if (waitlist.includes(uid)) throw new Error('Você já está na fila desta aula');
      const pos = waitlist.length + 1;
      t.set(enrRef, { ...base, status:'waitlist', waitlistPosition: pos }, { merge:true });
      t.update(clsRef, { waitlist: [...waitlist, uid] });
      return { status:'waitlist', position: pos };
    });

    hideLoading();
    if (result.status === 'waitlist') {
      showModal({
        icon:'⏳', iconBg:'var(--accent-dim)',
        title:'Você entrou na fila!',
        text:`Você está na posição #${result.position} da fila de espera. Se uma vaga abrir, você assume automaticamente! 🤙`,
        actions:[{label:'Entendido', style:'btn-accent', close:true}]
      });
    } else {
      confetti();
      showModal({
        icon:'✅', iconBg:'var(--success-dim)',
        title:'Inscrição realizada!',
        text:'Você está inscrito! Fique atento — enviaremos a confirmação em breve.',
        actions:[{label:'Ótimo!', style:'btn-success', close:true}]
      });
    }
    loadClassesForDay(window._currentDay);
  } catch(e) {
    hideLoading();
    const msg = (e && e.message && !/permission|insufficient/i.test(e.message))
      ? e.message
      : 'Inscrição não permitida — verifique a janela de inscrição do seu tipo de aluno.';
    showToast(msg, 'error');
    loadClassesForDay(window._currentDay);
  }
};

// ═══════════════════════════════════════════════════════════
//  STUDENT — MY CLASSES
// ═══════════════════════════════════════════════════════════
function screenStudentNotifs() {
  return `<div class="screen">
    <div class="topbar">
      <div class="topbar-back" onclick="App.go('${SCREENS.S_HOME}')">←</div>
      <span class="topbar-title">🔔 Notificações</span>
    </div>
    <div id="notifs-list" style="padding:0 20px 100px;display:flex;flex-direction:column;gap:10px">
      <div class="empty-state"><div class="empty-emoji">⌛</div></div>
    </div>
  </div>`;
}

function loadNotifications() {
  const list = document.getElementById('notifs-list');
  if (!list || !App.user || !App.arenaId) return;
  const col = db.collection('arenas').doc(App.arenaId)
    .collection('students').doc(App.user.uid).collection('notifications');
  col.orderBy('createdAt','desc').limit(30).get().then(snap => {
    if (snap.empty) {
      list.innerHTML = `<div class="empty-state"><div class="empty-emoji">🔕</div>
        <div class="empty-title">Nada por aqui</div>
        <div class="empty-text">Avisos sobre suas aulas e fila aparecem aqui.</div></div>`;
      return;
    }
    const icons = { class_cancelled:'❌', promoted:'🎉', removed:'🚫', info:'📣' };
    list.innerHTML = snap.docs.map(d => {
      const n = d.data();
      const when = n.createdAt?.toDate
        ? n.createdAt.toDate().toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})
        : '';
      return `<div class="card" style="${n.read?'opacity:.62':''}">
        <div class="flex gap-10">
          <span style="font-size:22px">${icons[n.type]||'📣'}</span>
          <div class="flex-1">
            <div class="t-h3">${n.title||''}</div>
            <div class="t-sm t-muted" style="margin-top:2px">${n.text||''}</div>
            <div class="t-sm t-dim" style="margin-top:6px">${when}</div>
          </div>
          ${!n.read ? '<span style="width:9px;height:9px;border-radius:50%;background:var(--primary);margin-top:6px"></span>' : ''}
        </div>
      </div>`;
    }).join('');
    // Marca como lidas
    const unread = snap.docs.filter(d => !d.data().read);
    if (unread.length) {
      const batch = db.batch();
      unread.forEach(d => batch.update(d.ref, { read: true }));
      batch.commit().catch(()=>{});
    }
  }).catch(() => {
    list.innerHTML = `<div class="empty-state"><div class="empty-emoji">🔕</div><div class="empty-title">Nada por aqui</div></div>`;
  });
}

function refreshNotifBadge() {
  if (!App.user || !App.arenaId) return;
  db.collection('arenas').doc(App.arenaId)
    .collection('students').doc(App.user.uid).collection('notifications')
    .where('read','==',false).get().then(snap => {
      const b = document.getElementById('notif-badge');
      if (!b) return;
      if (snap.size > 0) { b.textContent = snap.size > 9 ? '9+' : snap.size; b.style.display = 'block'; }
      else b.style.display = 'none';
    }).catch(()=>{});
}

function screenStudentClasses() {
  return `<div class="screen">
    <div class="topbar"><span class="topbar-title">📋 Minhas Aulas</span></div>
    <div style="padding:0 20px 16px">
      <div class="tabs">
        <div class="tab active" id="tab-upcoming" onclick="switchClassTab('upcoming',this)">Próximas</div>
        <div class="tab" id="tab-past" onclick="switchClassTab('past',this)">Histórico</div>
      </div>
    </div>
    <div id="my-classes-list" style="padding:0 20px;display:flex;flex-direction:column;gap:10px">
      <div class="empty-state"><div class="empty-emoji">⌛</div></div>
    </div>
  </div>`;
}
window.switchClassTab = function(type, el) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  loadMyClasses(type);
};

function liveStudentClasses() { loadMyClasses('upcoming'); }

function loadMyClasses(type) {
  const list = document.getElementById('my-classes-list');
  if (!list || !App.user || !App.arenaId) return;
  const uid = App.user.uid;
  const arenaId = App.arenaId;
  list.innerHTML = `<div class="empty-state"><div class="empty-emoji">⌛</div></div>`;
  db.collectionGroup('enrollments').where('studentId','==',uid).get().then(snap => {
    const now = new Date();
    const dtOf = (enr) => (enr.dateStr && enr.startTime)
      ? new Date(`${enr.dateStr}T${enr.startTime}`) : null;

    let items = snap.docs.filter(d => d.ref.path.includes(arenaId));
    // Cancelados (pelo aluno ou pela arena) saem das listas —
    // cancelamento pela arena aparece nas Notificações 🔔
    items = items.filter(d => !['cancelled','class_cancelled'].includes(d.data().status));
    // Abas: Próximas = aula ainda não começou; Histórico = já passou
    items = items.filter(d => {
      const dt = dtOf(d.data());
      if (!dt) return type === 'upcoming';
      return type === 'past' ? dt < now : dt >= now;
    });
    // Ordena: próximas em ordem crescente, histórico do mais recente
    items.sort((a,b) => {
      const da = dtOf(a.data()) || 0, db_ = dtOf(b.data()) || 0;
      return type === 'past' ? db_ - da : da - db_;
    });
    if (!items.length) {
      list.innerHTML = type === 'past'
        ? `<div class="empty-state"><div class="empty-emoji">📜</div><div class="empty-title">Sem histórico ainda</div></div>`
        : `<div class="empty-state"><div class="empty-emoji">🏖️</div><div class="empty-title">Sem aulas marcadas</div><div class="empty-text">Inscreva-se em uma aula na aba Horários!</div></div>`;
      return;
    }
    list.innerHTML = items.map(d => {
      const enr = d.data();
      const clsId = d.ref.parent.parent.id;
      return `<div class="class-card">
        <div class="flex items-center justify-between">
          <div>
            <div class="t-h3">${enr.modality||'Futevôlei'}</div>
            <div class="t-sm t-muted">${enr.dateStr||'—'} • ${enr.startTime||'—'}</div>
          </div>
          <span class="status-pill ${STATUS_CSS[enr.status]||''}">${STATUS_LABELS[enr.status]||enr.status}</span>
        </div>
        ${(type!=='past' && (enr.status==='invited'||enr.status==='confirmed')) ? `
        <div class="flex gap-8" style="margin-top:12px">
          <button class="btn btn-outline btn-sm flex-1" onclick="cancelEnrollment('${clsId}','${d.id}',false)">Cancelar</button>
        </div>` : (type!=='past' && enr.status==='waitlist') ? `
        <div class="flex gap-8" style="margin-top:12px">
          <button class="btn btn-outline btn-sm flex-1" onclick="cancelEnrollment('${clsId}','${d.id}',true)">Sair da fila (#${enr.waitlistPosition||'?'})</button>
        </div>` : ''}
      </div>`;
    }).join('') || `<div class="empty-state"><div class="empty-emoji">🏖️</div><div class="empty-title">Sem aulas</div></div>`;
  });
}

window.cancelEnrollment = async function(clsId, docId, isWaitlist) {
  const title = isWaitlist ? 'Sair da fila?' : 'Cancelar inscrição?';
  const text  = isWaitlist
    ? 'Você sairá da fila de espera desta aula.'
    : 'Se houver fila de espera, o próximo aluno assume sua vaga automaticamente.';
  confirmModal(title, text, '❌', async () => {
    showLoading();
    try {
      const uid = App.user.uid;
      const clsRef = db.collection('arenas').doc(App.arenaId).collection('classes').doc(clsId);
      const enrRef = clsRef.collection('enrollments').doc(uid);

      await db.runTransaction(async t => {
        const [clsSnap, enrSnap] = await Promise.all([t.get(clsRef), t.get(enrRef)]);
        const cls = clsSnap.data();
        if (!cls || !enrSnap.exists) throw new Error('Inscrição não encontrada');
        const status = enrSnap.data().status;
        const waitlist = cls.waitlist || [];

        if (status === 'waitlist') {
          // Sai da fila e reposiciona quem ficou
          const newWait = waitlist.filter(x => x !== uid);
          t.update(enrRef, { status:'cancelled',
            cancelledAt: firebase.firestore.FieldValue.serverTimestamp(),
            waitlistPosition: firebase.firestore.FieldValue.delete() });
          t.update(clsRef, { waitlist: newWait });
          newWait.forEach((wUid, i) =>
            t.update(clsRef.collection('enrollments').doc(wUid), { waitlistPosition: i + 1 }));
          return;
        }

        if (status === 'invited' || status === 'confirmed') {
          t.update(enrRef, { status:'cancelled',
            cancelledAt: firebase.firestore.FieldValue.serverTimestamp() });

          if (waitlist.length > 0) {
            // PROMOÇÃO AUTOMÁTICA: 1º da fila herda a vaga
            const nextUid = waitlist[0];
            const newWait = waitlist.slice(1);
            const enr0 = enrSnap.data();
            t.update(clsRef.collection('enrollments').doc(nextUid), {
              status:'invited',
              waitlistPosition: firebase.firestore.FieldValue.delete(),
              promotedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
            t.update(clsRef, { waitlist: newWait }); // vaga transferida: spotsUsed não muda
            newWait.forEach((wUid, i) =>
              t.update(clsRef.collection('enrollments').doc(wUid), { waitlistPosition: i + 1 }));
            t.set(notifRef(App.arenaId, nextUid), notifData('promoted',
              'Você saiu da fila! 🎉',
              `Uma vaga abriu e ela é sua: ${enr0.modality||'aula'} de ${enr0.dateStr||''} às ${enr0.startTime||''}.`,
              clsId));
          } else {
            t.update(clsRef, { spotsUsed: Math.max(0, (cls.spotsUsed||0) - 1) });
          }
          return;
        }
        throw new Error('Inscrição já cancelada');
      });

      hideLoading();
      showToast(isWaitlist ? 'Você saiu da fila' : 'Inscrição cancelada', 'warning');
      loadMyClasses('upcoming');
    } catch(e) {
      hideLoading();
      showToast(e?.message || 'Erro ao cancelar', 'error');
    }
  });
};

// ═══════════════════════════════════════════════════════════
//  STUDENT — RANKING
// ═══════════════════════════════════════════════════════════
function screenStudentRanking() {
  return `<div class="screen">
    <div class="topbar"><span class="topbar-title">🏆 Ranking</span></div>
    <div style="padding:0 20px 12px">
      <div class="tabs">
        <div class="tab active" id="rtab-month" onclick="switchRankTab('month',this)">Este mês</div>
        <div class="tab" id="rtab-total" onclick="switchRankTab('total',this)">Geral</div>
        <div class="tab" id="rtab-feed" onclick="switchRankTab('feed',this)">Comunidade</div>
      </div>
    </div>
    <div id="ranking-content">
      <div class="empty-state"><div class="empty-emoji">⌛</div></div>
    </div>
  </div>`;
}
window.switchRankTab = function(type, el) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  loadRanking(type);
};

function liveStudentRanking() { loadRanking('month'); }

function loadRanking(type) {
  const c = document.getElementById('ranking-content');
  if (!c || !App.arenaId) return;
  c.innerHTML = `<div class="empty-state"><div class="empty-emoji">⌛</div></div>`;

  if (type === 'feed') { loadCommunityFeed(c); return; }

  const field = type === 'month' ? 'monthClasses' : 'totalClasses';
  db.collection('arenas').doc(App.arenaId).collection('students')
    .orderBy(field,'desc').limit(20).get().then(snap => {
      if (snap.empty) {
        c.innerHTML = `<div class="empty-state"><div class="empty-emoji">🏖️</div><div class="empty-title">Ranking vazio</div><div class="empty-text">Participe de aulas para aparecer no ranking!</div></div>`;
        return;
      }
      const docs = snap.docs;
      const top3 = docs.slice(0,3);
      const rest = docs.slice(3);
      const uid = App.user?.uid;
      c.innerHTML = `
        <div class="podium">
          ${top3.length >= 2 ? `<div class="podium-item podium-2">
            <div>${renderAvatar(top3[1]?.data(),'avatar-md')}</div>
            <div class="t-xs t-center" style="font-weight:600">${(top3[1]?.data().name||'').split(' ')[0]}</div>
            <div class="podium-stand">2</div>
          </div>` : ''}
          ${top3.length >= 1 ? `<div class="podium-item podium-1">
            <div class="podium-crown">👑</div>
            <div>${renderAvatar(top3[1]?.data(),'avatar-md')}</div>
            <div class="t-sm t-center" style="font-weight:700">${(top3[0]?.data().name||'').split(' ')[0]}</div>
            <div class="podium-stand">1</div>
          </div>` : ''}
          ${top3.length >= 3 ? `<div class="podium-item podium-3">
            <div>${renderAvatar(top3[1]?.data(),'avatar-md')}</div>
            <div class="t-xs t-center" style="font-weight:600">${(top3[2]?.data().name||'').split(' ')[0]}</div>
            <div class="podium-stand">3</div>
          </div>` : ''}
        </div>
        <div style="margin-top:16px">
          ${rest.map((d,i) => {
            const data = d.data();
            const isMe = d.id === uid;
            return `<div class="rank-list-item">
              <span class="rank-num ${isMe ? 'me' : ''}">${i+4}</span>
              <div class="avatar avatar-sm ${isMe ? 'avatar-ring' : ''}">${getInitials(data.name||'?')}</div>
              <div class="flex-1">
                <div class="t-h3">${data.name||'—'} ${isMe?'<span style="color:var(--primary)">(você)</span>':''}</div>
                <div class="t-xs t-muted">${data.badges?.length||0} emblemas</div>
              </div>
              <span class="badge badge-primary">${data[field]||0}</span>
            </div>`;
          }).join('')}
        </div>`;
    });
}

function loadCommunityFeed(c) {
  if (!App.arenaId) return;
  db.collection('arenas').doc(App.arenaId).collection('feed')
    .orderBy('createdAt','desc').limit(20).get().then(snap => {
      if (snap.empty) {
        c.innerHTML = `<div class="empty-state"><div class="empty-emoji">💬</div><div class="empty-title">Nenhuma novidade</div><div class="empty-text">As conquistas da turma aparecerão aqui!</div></div>`;
        return;
      }
      c.innerHTML = snap.docs.map(d => {
        const f = d.data();
        const fid = d.id;
        const reactions = f.reactions || {};
        const emojis = ['👏','🔥','💪','😄'];
        return `<div class="feed-item">
          <div class="flex items-center gap-10">
            <div class="avatar avatar-sm">${getInitials(f.authorName||'?')}</div>
            <div>
              <span class="t-h3">${f.authorName||'—'}</span>
              <span class="t-xs t-muted" style="margin-left:6px">${timeAgo(f.createdAt)}</span>
            </div>
          </div>
          <p class="t-body" style="margin-top:8px">${f.text||''}</p>
          <div class="feed-reaction-row">
            ${emojis.map(em => {
              const count = (reactions[em]||[]).length;
              const reacted = (reactions[em]||[]).includes(App.user?.uid);
              return `<button class="reaction-btn ${reacted?'reacted':''}" onclick="reactFeed('${fid}','${em}')">
                ${em} ${count||''}
              </button>`;
            }).join('')}
          </div>
        </div>`;
      }).join('');
    });
}

window.reactFeed = async function(feedId, emoji) {
  if (!App.user || !App.arenaId) return;
  const ref = db.collection('arenas').doc(App.arenaId).collection('feed').doc(feedId);
  const snap = await ref.get();
  const reactions = snap.data()?.reactions || {};
  const arr = reactions[emoji] || [];
  const uid = App.user.uid;
  if (arr.includes(uid)) reactions[emoji] = arr.filter(x=>x!==uid);
  else reactions[emoji] = [...arr, uid];
  await ref.update({ reactions });
  loadRanking('feed');
};

// ═══════════════════════════════════════════════════════════
//  STUDENT — PROFILE
// ═══════════════════════════════════════════════════════════
function screenStudentProfile() {
  const p = App.profile || {};
  const totalBadges = BADGES.length;
  const earned = p.badges || [];
  const nivelBadge = p.nivel ? '<span class="badge ' + (p.nivel==='iniciante'?'badge-success':p.nivel==='intermediario'?'badge-warning':p.nivel==='avancado'?'badge-danger':p.nivel==='feminino'?'badge-accent':'badge-muted') + '">' + (p.nivel==='iniciante'?'🟢':p.nivel==='intermediario'?'🟡':p.nivel==='avancado'?'🔴':p.nivel==='feminino'?'🩷':'🟠') + ' ' + p.nivel + '</span>' : '';
  const tipoBadge = p.tipo ? '<span class="badge ' + (p.tipo==='mensalista'?'badge-primary':'badge-muted') + '">' + (p.tipo==='mensalista'?'⭐ Mensalista — inscrições ' + getEnrollWindowHours('mensalista') + 'h antes':'🎫 Avulso — inscrições ' + getEnrollWindowHours('avulso') + 'h antes') + '</span>' : '';
  const arenaBtn = !p.arenaId ? '<button class="btn btn-primary btn-sm" style="margin-top:10px" onclick="joinArena()">🏟️ Entrar em uma arena</button>' : '';
  return `<div class="screen">
    <div class="profile-header">
      <div onclick="uploadProfilePhoto()" style="position:relative;cursor:pointer;display:inline-block">
        ${renderAvatar(p,'avatar-xl')}
        <div style="position:absolute;bottom:2px;right:2px;width:30px;height:30px;
          background:var(--primary);border-radius:50%;display:flex;align-items:center;
          justify-content:center;font-size:15px;border:2px solid var(--bg)">📷</div>
      </div>
      <div class="t-h1">${p.name||'Aluno'}</div>
      <div class="t-sm t-muted">${p.email||''}</div>
      ${arenaBtn}
      <div style="display:flex;gap:8px;margin-top:8px;justify-content:center;flex-wrap:wrap">
        ${nivelBadge}${tipoBadge}
      </div>
      <div class="profile-stats" style="margin-top:16px">
        <div class="profile-stat"><div class="profile-stat-val">${p.totalClasses||0}</div><div class="profile-stat-lbl">Total aulas</div></div>
        <div class="profile-stat"><div class="profile-stat-val">${p.monthClasses||0}</div><div class="profile-stat-lbl">Este mês</div></div>
        <div class="profile-stat"><div class="profile-stat-val">${p.streakWeeks||0}🔥</div><div class="profile-stat-lbl">Sequência</div></div>
      </div>
    </div>
    <div class="section-header">
      <span class="section-title">🏅 Emblemas (${earned.length}/${totalBadges})</span>
    </div>
    <div class="progress-bar" style="margin:0 20px 12px">
      <div class="progress-fill" style="width:${Math.round(earned.length/totalBadges*100)}%"></div>
    </div>
    <div class="badge-grid" id="badge-grid">
      ${BADGES.map(b => {
        const isEarned = earned.includes(b.id);
        return '<div class="badge-item ' + (isEarned?'earned':'locked') + '" onclick="showBadgeDetail(\'' + b.id + '\',' + isEarned + ')" title="' + b.name + '"><span class="badge-emoji">' + b.emoji + '</span><span class="badge-name">' + b.name + '</span></div>';
      }).join('')}
    </div>
    <div class="settings-group" style="margin-top:16px">
      <div class="settings-label">Conta</div>
      <div class="settings-item" onclick="toggleBiometric()">
        <div class="settings-icon si-blue">🔐</div>
        <div class="flex-1"><div class="t-h3">Biometria</div><div class="t-xs t-muted">Login com digital ou face ID</div></div>
        <span class="settings-chevron">›</span>
      </div>
      <div class="settings-item" onclick="App.go('${SCREENS.FORGOT}')">
        <div class="settings-icon si-orange">🔑</div>
        <div class="flex-1"><div class="t-h3">Alterar senha</div><div class="t-xs t-muted">Redefina sua senha de acesso</div></div>
        <span class="settings-chevron">›</span>
      </div>
      <div class="settings-item" onclick="logoutUser()">
        <div class="settings-icon si-red">🚪</div>
        <div class="flex-1"><div class="t-h3">Sair</div><div class="t-xs t-muted">Encerrar sessão</div></div>
        <span class="settings-chevron">›</span>
      </div>
    </div>
  </div>`;
}

window.showBadgeDetail = function(badgeId, isEarned) {
  const b = BADGES.find(x => x.id === badgeId);
  if (!b) return;
  const p = App.profile || {};
  const total = p.totalClasses || 0;
  const streakWeeks = p.streakWeeks || 0;
  let progress = '';
  if (!isEarned && b.type === 'classes' && b.req > 0) {
    const pct = Math.min(Math.round(total / b.req * 100), 100);
    progress = `<div style="margin-top:14px">
      <div class="flex justify-between" style="margin-bottom:6px">
        <span class="t-xs t-muted">Seu progresso</span>
        <span class="t-xs t-primary">${total}/${b.req} aulas</span>
      </div>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
    </div>`;
  }
  if (!isEarned && b.type === 'streak_weeks' && b.req > 0) {
    const pct = Math.min(Math.round(streakWeeks / b.req * 100), 100);
    progress = `<div style="margin-top:14px">
      <div class="flex justify-between" style="margin-bottom:6px">
        <span class="t-xs t-muted">Sequência atual</span>
        <span class="t-xs t-primary">${streakWeeks}/${b.req} semanas</span>
      </div>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
    </div>`;
  }
  showModal({
    icon: b.emoji,
    iconBg: isEarned ? 'var(--success-dim)' : 'var(--surface)',
    title: isEarned ? `${b.name} ✅` : `🔒 ${b.name}`,
    text: b.desc,
    html: progress,
    actions:[{label: isEarned ? 'Incrível! 🎉' : 'Vou conquistar!', style: isEarned ? 'btn-success' : 'btn-primary', close:true}]
  });
};

   window.joinArena = function() {
  showModal({
    icon:'🏟️', iconBg:'var(--primary-dim)',
    title:'Entrar em uma arena',
    text:'Digite o código fornecido pelo gestor da sua arena:',
    html:`<div style="margin-top:16px">
      <input class="input" id="join-code" type="text" placeholder="Ex: AJJ123"
        maxlength="6" style="text-transform:uppercase;letter-spacing:4px;
        font-size:22px;font-weight:800;text-align:center">
    </div>`,
    actions:[
      {label:'Cancelar', style:'btn-outline', close:true},
      {label:'Entrar', style:'btn-primary', id:'confirm-join', close:true}
    ]
  });
  document.getElementById('join-code')?.addEventListener('input', function() {
    this.value = this.value.toUpperCase();
  });
  window._modalCallbacks['confirm-join'] = async () => {
    const code = document.getElementById('join-code')?.value.trim().toUpperCase();
    if (!code || code.length < 4) { showToast('Digite o código da arena','error'); return; }
    showLoading();
    try {
      const snap = await db.collection('arenas')
        .where('studentCode','==',code).limit(1).get();
      if (snap.empty) {
        hideLoading();
        showToast('Código inválido — verifique com o gestor','error');
        return;
      }
      const arenaId = snap.docs[0].id;
      const arena = snap.docs[0].data();
      await db.collection('users').doc(App.user.uid).update({ arenaId });
      await ensureStudentDoc(arenaId, App.user.uid, App.profile);
      App.profile = { ...App.profile, arenaId };
      App.arenaId = arenaId;
      App.arena = arena;
      hideLoading();
      confetti();
      showModal({
        icon:'🎉', iconBg:'var(--success-dim)',
        title:'Bem-vindo!',
        text:`Você entrou na ${arena.name}! O gestor vai configurar seu nível em breve.`,
        actions:[{label:'Ótimo!', style:'btn-success', close:true}],
        onClose: () => App.go(SCREENS.S_HOME)
      });
    } catch(e) {
      hideLoading();
      showToast('Erro ao entrar na arena','error');
    }
  };
};
window.toggleBiometric = function() {
  const stored = localStorage.getItem('af_biometric');
  if (stored) {
    confirmModal('Desativar Biometria?','Você precisará usar e-mail e senha para entrar.','🔐', () => {
      localStorage.removeItem('af_biometric');
      showToast('Biometria desativada','warning');
    });
  } else {
    showModal({
      icon:'🔐', iconBg:'var(--primary-dim)',
      title:'Ativar Biometria',
      text:'Para ativar, confirme sua senha abaixo:',
      html:`<div style="margin-top:16px"><input class="input" id="bio-pwd" type="password" placeholder="Sua senha atual"></div>`,
      actions:[
        {label:'Cancelar', style:'btn-outline', close:true},
        {label:'Ativar', style:'btn-primary', id:'activate-bio', close:true}
      ]
    });
    window._modalCallbacks['activate-bio'] = async () => {
      const pwd = document.getElementById('bio-pwd')?.value;
      if (!pwd) return;
      try {
        await auth.currentUser.reauthenticateWithCredential(
          firebase.auth.EmailAuthProvider.credential(App.user.email, pwd)
        );
        const data = btoa(JSON.stringify({email:App.user.email, password:pwd}));
        localStorage.setItem('af_biometric', data);
        showToast('Biometria ativada com sucesso! ✅','success');
      } catch(e) {
        showToast('Senha incorreta','error');
      }
    };
  }
};
window.logoutUser = function() {
  confirmModal('Sair da conta?','Você precisará fazer login novamente.','🚪', async () => {
    await auth.signOut();
    localStorage.removeItem('af_biometric');
  });
};

// ═══════════════════════════════════════════════════════════
//  ADMIN — HOME
// ═══════════════════════════════════════════════════════════
function screenAdminHome() {
  const a = App.arena || {};
  const g = App.profile || {};
  return `<div class="screen">
    <div class="home-hero" style="${a.photoBase64 ? 'background-image:linear-gradient(to bottom,rgba(7,7,17,0.45),rgba(7,7,17,0.9)),url(' + JSON.stringify(a.photoBase64) + ');background-size:cover;background-position:center;' : 'background:linear-gradient(160deg,rgba(255,94,26,0.12) 0%,transparent 60%);'}">
      <div class="flex items-center justify-between">
        <div class="home-greeting">
          <small>Painel da Arena</small>${a.name||'Arena'} 🏟️
        </div>
        <div class="avatar avatar-md" style="background:var(--accent-dim);color:var(--accent)"
          onclick="App.go('${SCREENS.A_SETTINGS}')">${getInitials(g.name||'A')}</div>
      </div>
      <div class="grid-2" style="margin-top:16px">
        <div class="stat-card primary"><div class="stat-value" id="adm-today">—</div><div class="stat-label">Aulas hoje</div></div>
        <div class="stat-card success"><div class="stat-value" id="adm-students">—</div><div class="stat-label">Alunos ativos</div></div>
      </div>
      <div class="grid-2" style="margin-top:10px">
        <div class="stat-card warning"><div class="stat-value" id="adm-waitlist">—</div><div class="stat-label">Na fila de espera</div></div>
        <div class="stat-card accent"><div class="stat-value" id="adm-occ">—</div><div class="stat-label">Taxa ocupação</div></div>
      </div>
    </div>
    <div id="adm-alerts-section"></div>
    <div class="section-header">
      <span class="section-title">📅 Aulas de hoje</span>
      <span class="section-action" onclick="App.go('${SCREENS.A_SCHEDULE}')">Ver agenda</span>
    </div>
    <div id="adm-today-classes" style="padding:0 20px;display:flex;flex-direction:column;gap:10px">
      <div class="empty-state"><div class="empty-emoji">⌛</div></div>
    </div>
    <div style="padding:20px 20px 0">
      <button class="btn btn-primary btn-full" onclick="App.go('${SCREENS.A_CREATE}')">
        ＋ Criar nova aula
      </button>
    </div>
  </div>`;
}

function liveAdminHome() {
  if (!App.arenaId) return;
  const aId = App.arenaId;
  const today = toLocalDateStr();

  // Today classes
  const unsub = db.collection('arenas').doc(aId).collection('classes')
    .where('dateStr','==',today).onSnapshot(snap => {
      const cls = snap.docs.filter(d => d.data().status !== 'cancelled');
      const at = document.getElementById('adm-today');
      if (at) at.textContent = cls.length;

      let totalSpots=0, totalUsed=0, totalWait=0;
      cls.forEach(d => {
        const data = d.data();
        totalSpots += data.maxSpots||0;
        totalUsed  += data.spotsUsed||0;
        totalWait  += data.waitlist?.length||0;
      });
      const aw = document.getElementById('adm-waitlist');
      const ao = document.getElementById('adm-occ');
      if (aw) aw.textContent = totalWait;
      if (ao) ao.textContent = totalSpots ? `${Math.round(totalUsed/totalSpots*100)}%` : '0%';

      const tc = document.getElementById('adm-today-classes');
      if (!tc) return;
      if (cls.length === 0) {
        tc.innerHTML = `<div class="empty-state" style="padding:32px 0"><div class="empty-emoji">📭</div><div class="empty-title">Sem aulas hoje</div><div class="empty-text">Crie uma aula para começar!</div></div>`;
        return;
      }
      tc.innerHTML = cls.map(d => {
        const c = d.data();
        const pct = Math.round((c.spotsUsed||0)/(c.maxSpots||1)*100);
        return `<div class="class-card status-${getClassStatus(c)}" onclick="App.go('${SCREENS.A_CLASS}',{clsId:'${d.id}'})">
          <div class="flex items-center justify-between">
            <div>
              <div class="t-h3">${c.modality||'Aula'}</div>
              <div class="t-sm t-muted">${c.startTime} – ${c.endTime}${c.court?' • '+c.court:''}</div>
              ${c.nivel ? '<span class="badge ' + (c.nivel==='iniciante'?'badge-success':c.nivel==='intermediario'?'badge-warning':c.nivel==='avancado'?'badge-danger':c.nivel==='feminino'?'badge-accent':'badge-muted') + '" style="margin-top:4px;display:inline-flex">' + (c.nivel==='iniciante'?'🟢':c.nivel==='intermediario'?'🟡':c.nivel==='avancado'?'🔴':c.nivel==='feminino'?'🩷':'🟠') + ' ' + c.nivel + '</span>' : ''}
            </div>
            <div class="t-center">
              <div class="t-h2" style="color:var(--primary)">${c.spotsUsed||0}/${c.maxSpots}</div>
              <div class="t-xs t-muted">inscritos</div>
            </div>
          </div>
          <div class="spots-bar" style="margin-top:10px">
            <div class="spots-fill ${pct>=90?'low':pct>=60?'medium':'high'}" style="width:${Math.min(pct,100)}%"></div>
          </div>
          ${c.waitlist?.length ? '<div class="t-xs" style="margin-top:6px;color:var(--accent)">' + c.waitlist.length + ' na fila de espera</div>' : ''}
        </div>`;
      }).join('');
    });
  App.unsubscribers.push(unsub);

  // Student count
  db.collection('arenas').doc(aId).collection('students')
    .where('status','==','active').get().then(s => {
      const el = document.getElementById('adm-students');
      if (el) el.textContent = s.size;
    });
}

// ═══════════════════════════════════════════════════════════
//  ADMIN — SCHEDULE
// ═══════════════════════════════════════════════════════════
function screenAdminSchedule() {
  const days = getWeekDays();
  return `<div class="screen">
    <div class="topbar"><span class="topbar-title">📅 Agenda</span></div>
    <div class="week-strip">
      ${days.map((d,i) => `<div class="day-pill ${i===0?'active':''}" data-date="${d.iso}" onclick="adminSelectDay('${d.iso}',this)">
        <span class="day-name">${d.name}</span>
        <span class="day-num">${d.num}</span>
        <div class="day-dot"></div>
      </div>`).join('')}
    </div>
    <div id="admin-classes-list" style="padding:0 20px;display:flex;flex-direction:column;gap:10px">
      <div class="empty-state"><div class="empty-emoji">⌛</div></div>
    </div>
    <button class="fab" onclick="App.go('${SCREENS.A_CREATE}')">＋</button>
  </div>`;
}
window.adminSelectDay = function(date, el) {
  document.querySelectorAll('.day-pill').forEach(d => d.classList.remove('active'));
  el.classList.add('active');
  loadAdminDayClasses(date);
};

function liveAdminSchedule() {
  const days = getWeekDays();
  loadAdminDayClasses(days[0].iso);
}

function loadAdminDayClasses(dateStr) {
  const list = document.getElementById('admin-classes-list');
  if (!list || !App.arenaId) return;
  list.innerHTML = `<div class="empty-state"><div class="empty-emoji">⌛</div></div>`;
 db.collection('arenas').doc(App.arenaId).collection('classes')
    .where('dateStr','==',dateStr).get().then(snap => {
      const visiveis = snap.docs.filter(d => d.data().status !== 'cancelled');
      const sortedDocs = visiveis.sort((a,b) => a.data().startTime.localeCompare(b.data().startTime));
      if (!visiveis.length) {
        list.innerHTML = `<div class="empty-state" style="padding:32px 0"><div class="empty-emoji">📭</div><div class="empty-title">Sem aulas neste dia</div><button class="btn btn-primary btn-sm" style="margin-top:12px" onclick="App.go('${SCREENS.A_CREATE}')">＋ Criar aula</button></div>`;
        return;
      }
      list.innerHTML = sortedDocs.map(d => {
        const c = d.data();
        const pct = Math.round((c.spotsUsed||0)/(c.maxSpots||1)*100);
        return `<div class="class-card status-${getClassStatus(c)}" onclick="App.go('${SCREENS.A_CLASS}',{clsId:'${d.id}'})">
          <div class="flex items-center justify-between">
            <div>
              <div class="t-h3">${c.modality||'Aula'}</div>
              <div class="t-sm t-muted">${c.startTime} – ${c.endTime}${c.court?' • '+c.court:''}</div>
              ${c.nivel ? `<span class="badge ${c.nivel==='iniciante'?'badge-success':c.nivel==='intermediario'?'badge-warning':c.nivel==='avancado'?'badge-danger':c.nivel==='feminino'?'badge-accent':'badge-muted'} badge-sm" style="margin-top:4px">${c.nivel==='iniciante'?'🟢':c.nivel==='intermediario'?'🟡':c.nivel==='avancado'?'🔴':c.nivel==='feminino'?'🩷':'🟠'} ${c.nivel}</span>` : ''}
            </div>
            <div>
              <div class="t-h2 t-center" style="color:var(--primary)">${c.spotsUsed||0}/${c.maxSpots}</div>
              <div class="t-xs t-muted">${c.waitlist?.length||0} fila</div>
            </div>
          </div>
          <div class="spots-bar" style="margin-top:8px">
            <div class="spots-fill ${pct>=90?'low':pct>=60?'medium':'high'}" style="width:${Math.min(pct,100)}%"></div>
          </div>
        </div>`;
      }).join('');
    });
}

// ═══════════════════════════════════════════════════════════
//  ADMIN — CLASS DETAIL
// ═══════════════════════════════════════════════════════════
function screenAdminClass() {
  return `<div class="screen">
    <div class="topbar">
      <button class="back-btn" onclick="App.go('${SCREENS.A_SCHEDULE}')">←</button>
      <span class="topbar-title" id="cls-title">Aula</span>
      <div></div>
    </div>
    <div id="cls-detail-body">
      <div class="empty-state"><div class="empty-emoji">⌛</div></div>
    </div>
  </div>`;
}

function liveAdminClass() {
  const clsId = App.params?.clsId;
  if (!clsId || !App.arenaId) return;
  const unsub = db.collection('arenas').doc(App.arenaId).collection('classes').doc(clsId)
    .onSnapshot(snap => {
      if (!snap.exists) return;
      const cls = snap.data();
      const titleEl = document.getElementById('cls-title');
      if (titleEl) titleEl.textContent = `${cls.modality} • ${cls.startTime}`;
      if (App.params?.mode === 'attendance' && cls.status !== 'done' && cls.status !== 'cancelled') {
        renderAttendanceMode(clsId, cls);
      } else {
        loadClassEnrollments(clsId, cls);
      }
    });
  App.unsubscribers.push(unsub);
}

// ── CHAMADA DE PRESENÇA ──────────────────────────────────────
function renderAttendanceMode(clsId, cls) {
  const body = document.getElementById('cls-detail-body');
  if (!body) return;
  db.collection('arenas').doc(App.arenaId).collection('classes').doc(clsId)
    .collection('enrollments').get().then(snap => {
      const enrolled = snap.docs.filter(d =>
        ['invited','confirmed','waiting'].includes(d.data().status));
      if (!enrolled.length) {
        body.innerHTML = `<div class="empty-state"><div class="empty-emoji">🤷</div>
          <div class="empty-title">Ninguém inscrito</div>
          <div class="empty-text">Sem inscritos para chamar presença.</div>
          <button class="btn btn-outline btn-sm" style="margin-top:12px"
            onclick="App.go('${SCREENS.A_CLASS}',{clsId:'${clsId}'})">← Voltar</button></div>`;
        return;
      }
      // Todos começam presentes; toque alterna
      window._attend = {};
      enrolled.forEach(d => window._attend[d.id] = true);
      body.innerHTML = `
        <div style="padding:0 20px 130px">
          <div class="card" style="margin-bottom:14px;text-align:center">
            <div class="t-h3">✅ Chamada de presença</div>
            <div class="t-sm t-muted" style="margin-top:4px">Toque no aluno que <b>faltou</b>. Ao encerrar, as presenças contam nas estatísticas.</div>
          </div>
          ${enrolled.map(d => {
            const e = d.data();
            return `<div class="attend-row" id="att-${d.id}" onclick="toggleAttendance('${d.id}')"
              style="cursor:pointer;border:1px solid var(--success);border-radius:12px;margin-bottom:8px">
              <div class="avatar avatar-sm">${getInitials(e.studentName||'?')}</div>
              <div class="flex-1"><div class="t-h3">${e.studentName||'—'}</div></div>
              <span id="att-ico-${d.id}" style="font-size:22px">✅</span>
            </div>`;
          }).join('')}
          <button class="btn btn-success btn-full btn-lg" style="margin-top:14px"
            onclick="finishAttendance('${clsId}')">🏁 Encerrar aula e salvar presenças</button>
          <button class="btn btn-ghost btn-full" style="margin-top:8px"
            onclick="App.go('${SCREENS.A_CLASS}',{clsId:'${clsId}'})">Cancelar chamada</button>
        </div>`;
    });
}

window.toggleAttendance = function(uid) {
  window._attend[uid] = !window._attend[uid];
  const row = document.getElementById('att-' + uid);
  const ico = document.getElementById('att-ico-' + uid);
  if (row) row.style.borderColor = window._attend[uid] ? 'var(--success)' : 'var(--danger)';
  if (row) row.style.opacity = window._attend[uid] ? '1' : '0.6';
  if (ico) ico.textContent = window._attend[uid] ? '✅' : '❌';
};

window.finishAttendance = async function(clsId) {
  const presentes = Object.values(window._attend||{}).filter(Boolean).length;
  const total = Object.keys(window._attend||{}).length;
  confirmModal('Encerrar aula?',
    `${presentes} de ${total} presentes. As presenças entram no Total e no Mês de cada aluno.`,
    '🏁', async () => {
    showLoading();
    try {
      const clsRef = db.collection('arenas').doc(App.arenaId).collection('classes').doc(clsId);
      const batch = db.batch();
      Object.entries(window._attend).forEach(([uid, presente]) => {
        batch.update(clsRef.collection('enrollments').doc(uid),
          { status: presente ? 'attended' : 'missed' });
        if (presente) {
          batch.update(
            db.collection('arenas').doc(App.arenaId).collection('students').doc(uid),
            { totalClasses: firebase.firestore.FieldValue.increment(1),
              monthClasses: firebase.firestore.FieldValue.increment(1),
              lastAttendanceAt: firebase.firestore.FieldValue.serverTimestamp() });
        }
      });
      batch.update(clsRef, { status: 'done',
        attendedCount: presentes,
        finishedAt: firebase.firestore.FieldValue.serverTimestamp() });
      await batch.commit();
      hideLoading();
      confetti();
      showToast(`Aula encerrada! ${presentes} presença(s) registrada(s) 🏐`,'success');
      App.go(SCREENS.A_CLASS, { clsId });
    } catch(e) {
      hideLoading();
      showToast(e?.message || 'Erro ao salvar presenças','error');
    }
  });
};

function loadClassEnrollments(clsId, cls) {
  const body = document.getElementById('cls-detail-body');
  if (!body) return;
  db.collection('arenas').doc(App.arenaId).collection('classes').doc(clsId)
    .collection('enrollments').get().then(snap => {
      const enrolled = snap.docs.filter(d => ['invited','confirmed','waiting'].includes(d.data().status));
      const waitlist = snap.docs.filter(d => d.data().status === 'waitlist');
      const pct = Math.round((cls.spotsUsed||0)/(cls.maxSpots||1)*100);
      body.innerHTML = `
        <div style="padding:0 20px 16px">
          <div class="card" style="margin-bottom:12px">
            <div class="grid-2">
              <div><div class="t-label t-dim">Data</div><div class="t-h3" style="margin-top:4px">${cls.dateStr||'—'}</div></div>
              <div><div class="t-label t-dim">Horário</div><div class="t-h3" style="margin-top:4px">${cls.startTime}–${cls.endTime}</div></div>
              <div><div class="t-label t-dim">Vagas</div><div class="t-h3" style="margin-top:4px">${cls.spotsUsed||0}/${cls.maxSpots}</div></div>
              <div><div class="t-label t-dim">Quadra</div><div class="t-h3" style="margin-top:4px">${cls.court||'—'}</div></div>
            </div>
            <div class="spots-bar" style="margin-top:12px">
              <div class="spots-fill ${pct>=90?'low':pct>=60?'medium':'high'}" style="width:${Math.min(pct,100)}%"></div>
            </div>
          </div>
          ${cls.status === 'done'
            ? `<div class="card" style="border:1px solid var(--success);text-align:center">
                <div class="t-h3" style="color:var(--success)">🏁 Aula encerrada</div>
                <div class="t-sm t-muted" style="margin-top:4px">${cls.attendedCount ?? 0} presença(s) registrada(s)</div>
              </div>`
            : cls.status === 'cancelled' ? '' : `
          <div class="flex gap-8">
            <button class="btn btn-primary flex-1" onclick="openAttendanceMode('${clsId}')">✅ Chamar presença</button>
            <button class="btn btn-outline btn-sm" onclick="sendConfirmations('${clsId}')">📱 WhatsApp</button>
          </div>`}
        </div>
        <div class="section-header"><span class="section-title">👥 Inscritos (${enrolled.length})</span></div>
        ${enrolled.length ? enrolled.map(d => {
          const e = d.data();
          return `<div class="attend-row">
            <div class="flex items-center gap-12 flex-1">
              <div class="avatar avatar-sm">${getInitials(e.studentName||'?')}</div>
              <div>
                <div class="t-h3">${e.studentName||'—'}</div>
                <span class="status-pill ${STATUS_CSS[e.status]||''}">${STATUS_LABELS[e.status]||e.status}</span>
              </div>
            </div>
            <button class="btn btn-ghost btn-sm t-danger" onclick="removeEnrollment('${clsId}','${d.id}')">✕</button>
          </div>`;
        }).join('') : '<div class="t-muted t-center" style="padding:16px">Nenhum inscrito</div>'}
        ${waitlist.length ? `
          <div class="section-header" style="margin-top:8px"><span class="section-title">⏳ Fila de espera (${waitlist.length})</span></div>
          ${waitlist.map((d,i) => {
            const e = d.data();
            return `<div class="attend-row">
              <span class="rank-num">${i+1}</span>
              <div class="avatar avatar-sm">${getInitials(e.studentName||'?')}</div>
              <div class="flex-1">
                <div class="t-h3">${e.studentName||'—'}</div>
              </div>
              <button class="btn btn-success btn-sm" onclick="promoteWaitlist('${clsId}','${d.id}')">Chamar</button>
            </div>`;
          }).join('')}
        ` : ''}
        ${cls.status === 'cancelled'
          ? `<div class="card" style="margin-top:16px;border:1px solid var(--danger);text-align:center">
              <div class="t-h3" style="color:var(--danger)">❌ Aula cancelada</div>
              <div class="t-sm t-muted" style="margin-top:4px">Os alunos inscritos foram notificados.</div>
            </div>`
          : cls.status === 'done' ? '<div style="padding-bottom:110px"></div>'
          : `<div style="margin-top:16px;padding-bottom:110px">
              <button class="btn btn-outline flex-1" style="width:100%;color:var(--danger);border-color:var(--danger)"
                onclick="adminCancelClass('${clsId}')">🗑️ Cancelar aula</button>
            </div>`}`;
    });
}

// Gestor cancela a aula: some da agenda dos alunos e cada
// inscrito/fila recebe notificação 🔔. Aula sem nenhuma
// movimentação é excluída de vez.
window.adminCancelClass = async function(clsId) {
  if (!App.arenaId) return;
  confirmModal('Cancelar esta aula?',
    'Ela sai da agenda dos alunos e todos os inscritos e a fila serão notificados.',
    '🗑️', async () => {
    showLoading();
    try {
      const clsRef = db.collection('arenas').doc(App.arenaId).collection('classes').doc(clsId);
      const [clsSnap, enrSnap] = await Promise.all([
        clsRef.get(),
        clsRef.collection('enrollments').get()
      ]);
      if (!clsSnap.exists) throw new Error('Aula não encontrada');
      const cls = clsSnap.data();
      const ativos = enrSnap.docs.filter(d =>
        ['invited','confirmed','waiting','waitlist'].includes(d.data().status));

      if (enrSnap.empty) {
        // Nunca teve movimentação: pode excluir de verdade
        await clsRef.delete();
      } else {
        const batch = db.batch();
        batch.update(clsRef, { status: 'cancelled',
          cancelledAt: firebase.firestore.FieldValue.serverTimestamp() });
        ativos.forEach(d => {
          batch.update(d.ref, { status: 'class_cancelled' });
          batch.set(notifRef(App.arenaId, d.id), notifData('class_cancelled',
            'Aula cancelada ❌',
            `A ${cls.modality||'aula'} de ${cls.dateStr||''} às ${cls.startTime||''} foi cancelada pela arena.`,
            clsId));
        });
        await batch.commit();
      }
      hideLoading();
      showToast('Aula cancelada','warning');
      App.go(SCREENS.A_SCHEDULE);
    } catch(e) {
      hideLoading();
      showToast(e?.message || 'Erro ao cancelar aula','error');
    }
  });
};

window.openAttendanceMode = function(clsId) {
  App.go(SCREENS.A_CLASS, {clsId, mode:'attendance'});
};

window.promoteWaitlist = async function(clsId, studentDocId) {
  if (!App.arenaId) return;
  showLoading();
  try {
    const clsRef = db.collection('arenas').doc(App.arenaId).collection('classes').doc(clsId);
    const enrRef = clsRef.collection('enrollments').doc(studentDocId);
    await db.runTransaction(async t => {
      const [clsSnap, enrSnap] = await Promise.all([t.get(clsRef), t.get(enrRef)]);
      const cls = clsSnap.data();
      if (!cls || !enrSnap.exists) throw new Error('Aula ou inscrição não encontrada');
      if (enrSnap.data().status !== 'waitlist') throw new Error('Este aluno não está na fila');
      if ((cls.spotsUsed||0) >= (cls.maxSpots||0))
        throw new Error('Aula lotada — aumente as vagas antes de promover');
      const newWait = (cls.waitlist||[]).filter(x => x !== studentDocId);
      const enr0 = enrSnap.data();
      t.update(enrRef, { status:'invited',
        waitlistPosition: firebase.firestore.FieldValue.delete(),
        promotedAt: firebase.firestore.FieldValue.serverTimestamp() });
      t.update(clsRef, { spotsUsed: (cls.spotsUsed||0) + 1, waitlist: newWait });
      newWait.forEach((wUid, i) =>
        t.update(clsRef.collection('enrollments').doc(wUid), { waitlistPosition: i + 1 }));
      t.set(notifRef(App.arenaId, studentDocId), notifData('promoted',
        'Você saiu da fila! 🎉',
        `O gestor confirmou sua vaga: ${enr0.modality||'aula'} de ${enr0.dateStr||''} às ${enr0.startTime||''}.`,
        clsId));
    });
    hideLoading();
    showToast('Aluno promovido da fila! ✅','success');
  } catch(e) {
    hideLoading();
    showToast(e?.message || 'Erro ao promover','error');
  }
};

window.removeEnrollment = async function(clsId, studentDocId) {
  if (!App.arenaId) return;
  confirmModal('Remover inscrição?','Se houver fila, o próximo aluno assume a vaga automaticamente.','❌', async () => {
    showLoading();
    try {
      const clsRef = db.collection('arenas').doc(App.arenaId).collection('classes').doc(clsId);
      const enrRef = clsRef.collection('enrollments').doc(studentDocId);
      await db.runTransaction(async t => {
        const [clsSnap, enrSnap] = await Promise.all([t.get(clsRef), t.get(enrRef)]);
        const cls = clsSnap.data();
        if (!cls || !enrSnap.exists) throw new Error('Inscrição não encontrada');
        const status = enrSnap.data().status;
        const waitlist = cls.waitlist || [];

        if (status === 'waitlist') {
          const newWait = waitlist.filter(x => x !== studentDocId);
          t.update(enrRef, { status:'cancelled',
            waitlistPosition: firebase.firestore.FieldValue.delete() });
          t.update(clsRef, { waitlist: newWait });
          newWait.forEach((wUid, i) =>
            t.update(clsRef.collection('enrollments').doc(wUid), { waitlistPosition: i + 1 }));
          return;
        }

        const enr0 = enrSnap.data();
        t.update(enrRef, { status:'cancelled' });
        t.set(notifRef(App.arenaId, studentDocId), notifData('removed',
          'Inscrição removida',
          `O gestor removeu sua inscrição na ${enr0.modality||'aula'} de ${enr0.dateStr||''} às ${enr0.startTime||''}.`,
          clsId));
        if (waitlist.length > 0) {
          const nextUid = waitlist[0];
          const newWait = waitlist.slice(1);
          t.update(clsRef.collection('enrollments').doc(nextUid), {
            status:'invited',
            waitlistPosition: firebase.firestore.FieldValue.delete(),
            promotedAt: firebase.firestore.FieldValue.serverTimestamp() });
          t.update(clsRef, { waitlist: newWait });
          newWait.forEach((wUid, i) =>
            t.update(clsRef.collection('enrollments').doc(wUid), { waitlistPosition: i + 1 }));
          t.set(notifRef(App.arenaId, nextUid), notifData('promoted',
            'Você saiu da fila! 🎉',
            `Uma vaga abriu e ela é sua: ${enr0.modality||'aula'} de ${enr0.dateStr||''} às ${enr0.startTime||''}.`,
            clsId));
        } else if ((cls.spotsUsed||0) > 0) {
          t.update(clsRef, { spotsUsed: cls.spotsUsed - 1 });
        }
      });
      hideLoading();
      showToast('Inscrição removida','warning');
    } catch(e) {
      hideLoading();
      showToast(e?.message || 'Erro ao remover','error');
    }
  });
};

window.sendConfirmations = function(clsId) {
  showModal({
    icon:'📱', iconBg:'var(--success-dim)',
    title:'Enviar via WhatsApp',
    text:'Isso enviará mensagens de confirmação para todos os inscritos desta aula.',
    actions:[
      {label:'Cancelar', style:'btn-outline', close:true},
      {label:'Enviar agora', style:'btn-success', id:'send-wa', close:true}
    ]
  });
  window._modalCallbacks['send-wa'] = async () => {
    showLoading();
    try {
      const fn = firebase.functions();
      await fn.httpsCallable('sendClassConfirmations')({arenaId:App.arenaId, clsId});
      hideLoading();
      showToast('Mensagens enviadas!','success');
    } catch(e) {
      hideLoading();
      showToast('Configure o WhatsApp nas configurações','warning');
    }
  };
};

// ═══════════════════════════════════════════════════════════
//  ADMIN — CREATE CLASS
// ═══════════════════════════════════════════════════════════
function screenAdminCreate() {
  const today = new Date().toISOString().slice(0,10);
  const settings = App.arena?.settings || {};
  return `<div class="screen">
    <div class="topbar">
      <button class="back-btn" onclick="App.go('${SCREENS.A_SCHEDULE}')">←</button>
      <span class="topbar-title">Nova Aula</span>
      <div></div>
    </div>
    <div style="padding:16px 20px;display:flex;flex-direction:column;gap:16px">
     <div class="field">
        <label>Nível da turma</label>
        <select class="input" id="cls-nivel">
          <option value="todos">🌍 Todos os níveis</option>
          <option value="iniciante">🟢 Iniciante</option>
          <option value="intermediario">🟡 Intermediário</option>
          <option value="avancado">🔴 Avançado</option>
          <option value="intermediario_avancado">🟠 Intermediário/Avançado</option>
          <option value="feminino">🩷 Feminino</option>
        </select>
      </div>
      <div class="field">
        <label>Modalidade</label>
        <select class="input" id="cls-modality">
          <option value="Futevôlei">Futevôlei</option>
          <option value="Vôlei">Vôlei</option>
          <option value="Beach Tennis">Beach Tennis</option>
          <option value="Futsal">Futsal</option>
          <option value="Outro">Outro</option>
        </select>
      </div>
      <div class="grid-2">
        <div class="field">
          <label>Data</label>
          <input class="input" id="cls-date" type="date" value="${today}" min="${today}">
        </div>
        <div class="field">
          <label>Quadra</label>
          <input class="input" id="cls-court" type="text" placeholder="Ex: Quadra 1">
        </div>
      </div>
      <div class="grid-2">
        <div class="field">
          <label>Início</label>
          <input class="input" id="cls-start" type="time" value="08:00">
        </div>
        <div class="field">
          <label>Término</label>
          <input class="input" id="cls-end" type="time" value="09:00">
        </div>
      </div>
      <div class="field">
        <label>Número de vagas</label>
        <input class="input" id="cls-spots" type="number" value="6" min="1" max="50">
      </div>
      <div class="field">
        <label>🔁 Repetir</label>
        <select class="input" id="cls-repeat" onchange="document.getElementById('repeat-opts').style.display = this.value==='weekly' ? 'block' : 'none'">
          <option value="none">Não repete (aula única)</option>
          <option value="weekly">Toda semana, nos dias escolhidos</option>
        </select>
      </div>
      <div id="repeat-opts" style="display:none">
        <div class="field">
          <label>Dias da semana</label>
          <div class="flex gap-8" style="flex-wrap:wrap" id="wd-chips">
            ${['D','S','T','Q','Q','S','S'].map((l,i) =>
              `<div class="chip" data-wd="${i}" onclick="this.classList.toggle('active')"
                style="min-width:42px;text-align:center;cursor:pointer">${['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'][i]}</div>`).join('')}
          </div>
        </div>
        <div class="field" style="margin-top:12px">
          <label>Criar aulas para as próximas</label>
          <select class="input" id="cls-rep-weeks">
            <option value="4">4 semanas</option>
            <option value="8">8 semanas</option>
            <option value="12">12 semanas</option>
          </select>
        </div>
        <div class="t-sm t-dim" style="margin-top:8px">A data acima é o ponto de partida. Ex.: Seg + Qua por 4 semanas = 8 aulas criadas de uma vez.</div>
      </div>
      <div class="field">
        <label>Convidar alunos</label>
        <select class="input" id="cls-invite">
          <option value="all">Todos os alunos ativos</option>
          <option value="none">Nenhum (criar só a aula)</option>
        </select>
      </div>
      <button class="btn btn-primary btn-full btn-lg" id="btn-create-class">
        🏐 Criar aula e enviar convites
      </button>
    </div>
  </div>`;
}
function attachAdminCreate() {
  document.getElementById('btn-create-class')?.addEventListener('click', async () => {
    const modality = document.getElementById('cls-modality')?.value;
    const dateStr  = document.getElementById('cls-date')?.value;
    const court    = document.getElementById('cls-court')?.value.trim();
    const start    = document.getElementById('cls-start')?.value;
    const end      = document.getElementById('cls-end')?.value;
    const spots    = parseInt(document.getElementById('cls-spots')?.value);
    const invite   = document.getElementById('cls-invite')?.value;
    const nivel    = document.getElementById('cls-nivel')?.value;
    if (!dateStr||!start||!end||!spots) { showToast('Preencha todos os campos','error'); return; }
    if (start >= end) { showToast('Horário de início deve ser antes do término','error'); return; }
    // Datas da série: única, ou semanal nos dias marcados
    const repeat = document.getElementById('cls-repeat')?.value || 'none';
    let datas = [dateStr];
    if (repeat === 'weekly') {
      const dias = [...document.querySelectorAll('#wd-chips .chip.active')]
        .map(el => parseInt(el.dataset.wd));
      if (!dias.length) { showToast('Escolha os dias da semana','error'); return; }
      const semanas = parseInt(document.getElementById('cls-rep-weeks')?.value || '4');
      datas = [];
      const inicio = new Date(`${dateStr}T12:00:00`);
      for (let i = 0; i < semanas * 7; i++) {
        const d = new Date(inicio);
        d.setDate(inicio.getDate() + i);
        if (dias.includes(d.getDay())) {
          datas.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`);
        }
      }
      if (!datas.length) { showToast('Nenhuma data gerada — confira os dias','error'); return; }
    }

    showLoading();
    try {
      const col = db.collection('arenas').doc(App.arenaId).collection('classes');
      const batch = db.batch();
      datas.forEach(ds => {
        batch.set(col.doc(), {
          modality, dateStr: ds, startTime:start, endTime:end, court,
          maxSpots: spots, spotsUsed: 0, waitlist: [],
          status: 'open', invite, nivel,
          startTimestamp: firebase.firestore.Timestamp.fromDate(new Date(`${ds}T${start}`)),
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
      });
      await batch.commit();
      hideLoading();
      confetti();
      showModal({
        icon:'✅', iconBg:'var(--success-dim)',
        title: datas.length > 1 ? `${datas.length} aulas criadas!` : 'Aula criada!',
        text: datas.length > 1
          ? `Sua grade foi montada: ${datas.length} aulas de ${modality} criadas até ${datas[datas.length-1].split('-').reverse().join('/')}.`
          : 'Aula criada com sucesso!',
        actions:[{label:'Ver agenda', style:'btn-primary', close:true}],
        onClose: () => App.go(SCREENS.A_SCHEDULE)
      });
    } catch(e) {
      hideLoading();
      showToast('Erro ao criar aula(s)','error');
    }
  });
}

// ═══════════════════════════════════════════════════════════
//  ADMIN — STUDENTS
// ═══════════════════════════════════════════════════════════
function screenAdminStudents() {
  return `<div class="screen">
    <div class="topbar"><span class="topbar-title">👥 Alunos</span></div>
    <div class="search-bar">
      <span>🔍</span>
      <input type="search" placeholder="Buscar aluno..." id="student-search" oninput="filterStudents(this.value)">
    </div>
    <div class="chip-row">
      <div class="chip active" data-sf="active" onclick="filterStudentStatus('active',this)">Ativos</div>
      <div class="chip" data-sf="inactive" onclick="filterStudentStatus('inactive',this)">Inativos</div>
      <div class="chip" data-sf="blocked" onclick="filterStudentStatus('blocked',this)">Bloqueados</div>
    </div>
    <div id="students-list"></div>
  </div>`;
}
window._allStudents = [];
window.filterStudents = function(q) {
  const list = window._allStudents.filter(s =>
    s.name.toLowerCase().includes(q.toLowerCase()) ||
    s.email?.toLowerCase().includes(q.toLowerCase())
  );
  renderStudentList(list);
};
window.filterStudentStatus = function(status, el) {
  document.querySelectorAll('[data-sf]').forEach(c=>c.classList.remove('active'));
  el.classList.add('active');
  const filtered = window._allStudents.filter(s => (s.status||'active')===status);
  renderStudentList(filtered);
};

function renderStudentList(students) {
  const list = document.getElementById('students-list');
  if (!list) return;
  if (!students.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-emoji">👥</div><div class="empty-title">Nenhum aluno</div></div>`;
    return;
  }
  list.innerHTML = students.map(s => {
    const statusDot = {active:'dot-success', inactive:'dot-warning', blocked:'dot-danger'}[s.status||'active'];
    const nivelBadge = s.nivel
      ? '<span class="badge ' + (s.nivel==='iniciante'?'badge-success':s.nivel==='intermediario'?'badge-warning':s.nivel==='avancado'?'badge-danger':s.nivel==='feminino'?'badge-accent':'badge-muted') + '">' + (s.nivel==='iniciante'?'🟢':s.nivel==='intermediario'?'🟡':s.nivel==='avancado'?'🔴':s.nivel==='feminino'?'🩷':'🟠') + ' ' + s.nivel + '</span>'
      : '<span class="badge badge-muted">sem nível</span>';
    const tipoBadge = s.tipo
      ? '<span class="badge ' + (s.tipo==='mensalista'?'badge-primary':'badge-muted') + '">' + (s.tipo==='mensalista'?'⭐ Mensalista':'🎫 Avulso') + '</span>'
      : '';
    return `<div class="arena-row" onclick="App.go('${SCREENS.A_STUDENT}',{uid:'${s.id}'})">
      <div class="avatar avatar-md">${getInitials(s.name||'?')}</div>
      <div class="flex-1">
        <div class="t-h3">${s.name||'—'}</div>
        <div class="t-xs t-muted">${s.totalClasses||0} aulas • ${s.badges?.length||0} emblemas</div>
        <div style="display:flex;gap:6px;margin-top:4px;flex-wrap:wrap">
          ${nivelBadge}${tipoBadge}
        </div>
      </div>
      <div class="flex items-center gap-8">
        <span class="dot ${statusDot}"></span>
        <span class="t-xs t-muted">${s.monthClasses||0} este mês</span>
      </div>
    </div>`;
  }).join('');
}
// ═══════════════════════════════════════════════════════════
//  ADMIN — STUDENT DETAIL
// ═══════════════════════════════════════════════════════════
function screenAdminStudentDetail() {
  return `<div class="screen">
    <div class="topbar">
      <button class="back-btn" onclick="App.go('${SCREENS.A_STUDENTS}')">←</button>
      <span class="topbar-title">Perfil do Aluno</span>
      <div></div>
    </div>
    <div id="student-detail-body">
      <div class="empty-state"><div class="empty-emoji">⌛</div></div>
    </div>
  </div>`;
}

function liveAdminStudentDetail() {
  const uid = App.params?.uid;
  if (!uid || !App.arenaId) return;
  const sRef = db.collection('arenas').doc(App.arenaId).collection('students').doc(uid);
  sRef.get().then(async snap => {
    const body = document.getElementById('student-detail-body');
    if (!body) return;
    if (!snap.exists) {
      // Auto-reparo: aluno existe em users mas não em /students — cria agora
      try {
        const uSnap = await db.collection('users').doc(uid).get();
        if (uSnap.exists && uSnap.data().arenaId === App.arenaId) {
          const u = uSnap.data();
          await sRef.set({
            name: u.name || '', email: u.email || '',
            photoBase64: u.photoBase64 || null,
            status: 'active', tipo: null, nivel: null, slots: [],
            totalClasses: 0, monthClasses: 0, streakWeeks: 0,
            badges: u.badges || ['first'],
            joinedAt: firebase.firestore.FieldValue.serverTimestamp()
          });
          snap = await sRef.get();
        }
      } catch(e) { console.warn('auto-reparo aluno falhou:', e?.message); }
      if (!snap.exists) {
        body.innerHTML = `<div class="empty-state"><div class="empty-emoji">❓</div><div class="empty-title">Aluno não encontrado</div></div>`;
        return;
      }
    }
    const s = snap.data();
    const earned = s.badges || [];
    const statusMap = {active:'badge-success',inactive:'badge-warning',blocked:'badge-danger'};
    body.innerHTML = `
      <div class="profile-header">
        <div class="avatar avatar-xl">${getInitials(s.name||'?')}</div>
        <div class="t-h1">${s.name||'—'}</div>
        <span class="badge ${statusMap[s.status||'active']}">${s.status==='active'?'Ativo':s.status==='blocked'?'Bloqueado':'Inativo'}</span>
        <div class="profile-stats" style="margin-top:16px">
          <div class="profile-stat"><div class="profile-stat-val">${s.totalClasses||0}</div><div class="profile-stat-lbl">Total</div></div>
          <div class="profile-stat"><div class="profile-stat-val">${s.monthClasses||0}</div><div class="profile-stat-lbl">Mês</div></div>
          <div class="profile-stat"><div class="profile-stat-val">${s.streakWeeks||0}🔥</div><div class="profile-stat-lbl">Streak</div></div>
        </div>
      </div>
      <div class="section-header" style="margin-top:8px">
        <span class="section-title">🎯 Nível e Tipo</span>
      </div>
      <div style="padding:0 20px 16px;display:flex;flex-direction:column;gap:12px">
        <div class="field">
          <label>Nível do aluno</label>
          <select class="input" id="student-nivel" onchange="updateStudentNivel('${uid}',this.value)">
            <option value="" ${!s.nivel?'selected':''}>Selecione o nível...</option>
            <option value="iniciante" ${s.nivel==='iniciante'?'selected':''}>🟢 Iniciante</option>
            <option value="intermediario" ${s.nivel==='intermediario'?'selected':''}>🟡 Intermediário</option>
            <option value="avancado" ${s.nivel==='avancado'?'selected':''}>🔴 Avançado</option>
            <option value="intermediario_avancado" ${s.nivel==='intermediario_avancado'?'selected':''}>🟠 Intermediário/Avançado</option>
            <option value="feminino" ${s.nivel==='feminino'?'selected':''}>🩷 Feminino</option>
          </select>
        </div>
        <div class="field">
          <label>Tipo de aluno</label>
          <select class="input" id="student-tipo" onchange="updateStudentTipo('${uid}',this.value)">
            <option value="" ${!s.tipo?'selected':''}>Selecione o tipo...</option>
            <option value="mensalista" ${s.tipo==='mensalista'?'selected':''}>⭐ Mensalista</option>
            <option value="avulso" ${s.tipo==='avulso'?'selected':''}>🎫 Avulso</option>
          </select>
        </div>
      </div>
      <div class="section-header" style="margin-top:8px">
        <span class="section-title">📅 Aulas habilitadas</span>
      </div>
      <div style="padding:0 20px 16px">
        <div class="t-sm t-muted" style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r-md);padding:14px 16px">
          ${s.nivel
            ? `O aluno vê e participa das aulas do nível dele e das turmas "🌍 Todos os níveis".`
            : `⚠️ <b>Defina o nível acima</b> — sem nível, o aluno só vê as turmas "🌍 Todos os níveis".`}
        </div>
      </div>
      <div style="padding:0 20px 110px">
        <div class="flex gap-10" style="margin-bottom:16px">
          ${s.status!=='blocked'
            ? `<button class="btn btn-danger flex-1" onclick="blockStudent('${uid}')">⛔ Bloquear</button>`
            : `<button class="btn btn-success flex-1" onclick="unblockStudent('${uid}')">✅ Desbloquear</button>`}
        </div>
      </div>
      <div class="section-header"><span class="section-title">🏅 Emblemas (${earned.length})</span></div>
      <div class="badge-grid">
        ${BADGES.map(b => {
          const isEarned = earned.includes(b.id);
          return `<div class="badge-item ${isEarned?'earned':'locked'}">
            <span class="badge-emoji">${b.emoji}</span>
            <span class="badge-name">${b.name}</span>
          </div>`;
        }).join('')}
      </div>`;
  });
}
window.addStudentSlot = async function(uid) {
  const val = document.getElementById('new-slot-input')?.value;
  if (!val) { showToast('Selecione o horário','error'); return; }
  showLoading();
  try {
    const slotStr = val; // formato HH:MM
    await db.collection('arenas').doc(App.arenaId).collection('students').doc(uid)
      .update({ slots: firebase.firestore.FieldValue.arrayUnion(slotStr) });
    await db.collection('users').doc(uid)
      .update({ slots: firebase.firestore.FieldValue.arrayUnion(slotStr) }).catch(()=>{});
    hideLoading();
    showToast(`Horário ${slotStr} adicionado! ✅`,'success');
    liveAdminStudentDetail();
  } catch(e) { hideLoading(); showToast('Erro ao adicionar','error'); }
};

window.removeStudentSlot = async function(uid, slot) {
  confirmModal('Remover horário?',`O aluno não verá mais as aulas das ${slot}.`,'⏰', async () => {
    showLoading();
    try {
      await db.collection('arenas').doc(App.arenaId).collection('students').doc(uid)
        .update({ slots: firebase.firestore.FieldValue.arrayRemove(slot) });
      await db.collection('users').doc(uid)
        .update({ slots: firebase.firestore.FieldValue.arrayRemove(slot) }).catch(()=>{});
      hideLoading();
      showToast(`Horário ${slot} removido`,'warning');
      liveAdminStudentDetail();
    } catch(e) { hideLoading(); showToast('Erro','error'); }
  });
};
window.updateStudentNivel = async function(uid, nivel) {
  if (!nivel) return;
  showLoading();
  try {
    await db.collection('arenas').doc(App.arenaId).collection('students').doc(uid)
      .update({ nivel });
    await db.collection('users').doc(uid).update({ nivel }).catch(()=>{});
    hideLoading();
    showToast(`Nível atualizado: ${nivel} ✅`, 'success');
  } catch(e) { hideLoading(); showToast('Erro ao atualizar nível','error'); }
};

window.updateStudentTipo = async function(uid, tipo) {
  if (!tipo) return;
  showLoading();
  try {
    await db.collection('arenas').doc(App.arenaId).collection('students').doc(uid)
      .update({ tipo });
    await db.collection('users').doc(uid).update({ tipo }).catch(()=>{});
    hideLoading();
    showToast(`Tipo atualizado: ${tipo} ✅`, 'success');
  } catch(e) { hideLoading(); showToast('Erro ao atualizar tipo','error'); }
};

window.blockStudent = async function(uid) {
  confirmModal('Bloquear aluno?','O aluno perderá acesso ao app desta arena.','⛔', async () => {
    await db.collection('arenas').doc(App.arenaId).collection('students').doc(uid).update({status:'blocked'});
    showToast('Aluno bloqueado','warning');
    liveAdminStudentDetail();
  });
};
window.unblockStudent = async function(uid) {
  await db.collection('arenas').doc(App.arenaId).collection('students').doc(uid).update({status:'active'});
  showToast('Aluno reativado','success');
  liveAdminStudentDetail();
};

// ═══════════════════════════════════════════════════════════
//  ADMIN — REPORTS
// ═══════════════════════════════════════════════════════════
function screenAdminReports() {
  return `<div class="screen">
    <div class="topbar"><span class="topbar-title">📊 Relatórios</span></div>
    <div id="reports-body" style="padding:0 20px">
      <div class="empty-state"><div class="empty-emoji">⌛</div></div>
    </div>
  </div>`;
}
function liveAdminReports() {
  if (!App.arenaId) return;
  const month = toLocalDateStr().slice(0,7);
  const monthStart = `${month}-01`;
  db.collection('arenas').doc(App.arenaId).collection('classes')
    .where('dateStr','>=',monthStart).get().then(snap => {
      const body = document.getElementById('reports-body');
      if (!body) return;
      let totalClasses=0, totalSpots=0, totalUsed=0, totalWait=0;
      snap.docs.forEach(d => {
        const c = d.data();
        totalClasses++;
        totalSpots += c.maxSpots||0;
        totalUsed  += c.spotsUsed||0;
        totalWait  += c.waitlist?.length||0;
      });
      const occ = totalSpots ? Math.round(totalUsed/totalSpots*100) : 0;
      body.innerHTML = `
        <div class="alert-banner info" style="margin:16px 0 0">
          <span class="alert-banner-icon">💡</span>
          <div class="alert-banner-text">Relatório de ${new Date().toLocaleDateString('pt-BR',{month:'long',year:'numeric'})}</div>
        </div>
        <div class="grid-2" style="margin-top:16px">
          <div class="stat-card primary"><div class="stat-value">${totalClasses}</div><div class="stat-label">Aulas no mês</div></div>
          <div class="stat-card success"><div class="stat-value">${occ}%</div><div class="stat-label">Taxa ocupação</div></div>
          <div class="stat-card accent"><div class="stat-value">${totalUsed}</div><div class="stat-label">Presenças</div></div>
          <div class="stat-card warning"><div class="stat-value">${totalWait}</div><div class="stat-label">Fila de espera</div></div>
        </div>
        ${occ < 50 ? `<div class="alert-banner warning" style="margin-top:16px">
          <span class="alert-banner-icon">⚠️</span>
          <div class="alert-banner-text">Taxa de ocupação abaixo de 50%. Considere estratégias para aumentar o engajamento.</div>
        </div>` : ''}
        ${occ >= 90 ? `<div class="alert-banner success" style="margin-top:16px">
          <span class="alert-banner-icon">🚀</span>
          <div class="alert-banner-text">Excelente! Arena com mais de 90% de ocupação. Considere abrir novas turmas.</div>
        </div>` : ''}`;
    });
}

// ═══════════════════════════════════════════════════════════
//  ADMIN — SETTINGS
// ═══════════════════════════════════════════════════════════
function screenAdminSettings() {
  const a = App.arena || {};
  const s = a.settings || {};
  return `<div class="screen">
    <div class="topbar"><span class="topbar-title">⚙️ Configurações</span></div>
    <div class="settings-group">
      <div class="settings-label">Arena</div>
      <div class="settings-item" onclick="uploadArenaPhoto()">
        <div class="settings-icon si-blue" style="overflow:hidden;padding:0">
          ${a.photoBase64
            ? `<img src="${a.photoBase64}" style="width:100%;height:100%;object-fit:cover;border-radius:10px">`
            : `<span style="font-size:18px;display:flex;align-items:center;justify-content:center;height:100%">📸</span>`}
        </div>
        <div class="flex-1"><div class="t-h3">Foto da arena</div><div class="t-xs t-muted">${a.photoBase64?'Toque para alterar':'Adicionar foto da quadra'}</div></div>
        <span class="settings-chevron">›</span>
      </div>
      <div class="settings-item">
        <div class="settings-icon si-green">🎫</div>
        <div class="flex-1">
          <div class="t-h3">Código para alunos</div>
          <div style="font-size:22px;font-weight:800;letter-spacing:4px;color:var(--success)">${a.studentCode||'—'}</div>
          <div class="t-xs t-muted">Compartilhe com seus alunos</div>
        </div>
        <button class="btn btn-success btn-sm" onclick="navigator.clipboard.writeText('${a.studentCode||''}').then(()=>showToast('Código copiado!','success'))">Copiar</button>
      </div>
    </div>
    ${ (a.gestorUid && App.user && a.gestorUid === App.user.uid) ? `
    <div class="settings-group">
      <div class="settings-label">👥 Equipe</div>
      <div style="padding:0 20px 12px">
        <div class="t-sm t-muted" style="margin-bottom:12px">
          Funcionários podem criar aulas e gerenciar alunos e filas.
          Adicione pelo e-mail — a pessoa entra no app com ele e aceita o convite.
        </div>
        ${(a.staffEmails||[]).map(em => `
          <div class="flex items-center gap-8" style="margin-bottom:8px;background:var(--surface-2);border-radius:10px;padding:10px 12px">
            <span class="flex-1 t-sm">${em}</span>
            <button class="btn btn-outline btn-sm" onclick="removeStaffEmail('${em}')">Remover</button>
          </div>`).join('') || '<div class="t-sm t-dim" style="margin-bottom:8px">Nenhum funcionário ainda</div>'}
        <div class="flex gap-8" style="margin-top:8px">
          <input class="input flex-1" id="staff-email" type="email" placeholder="email@funcionario.com">
          <button class="btn btn-primary" onclick="addStaffEmail()">Adicionar</button>
        </div>
      </div>
    </div>` : ''}
    <div class="settings-group">
      <div class="settings-label">WhatsApp</div>
      <div style="padding:0 20px 12px">
        <div class="wa-status disconnected" id="wa-status" style="margin-bottom:12px">
          <span>⌛</span> Verificando configuração...
        </div>
        <div class="field">
          <label>Token da API (Meta WhatsApp Cloud)</label>
          <input class="input" id="wa-token" type="password" placeholder="EAAxxxx...">
        </div>
        <div class="field" style="margin-top:12px">
          <label>Phone Number ID</label>
          <input class="input" id="wa-phone-id" placeholder="1234567890">
        </div>
        <button class="btn btn-primary btn-full" style="margin-top:12px" id="btn-save-wa">Salvar configuração WhatsApp</button>
        <p class="t-xs t-muted" style="margin-top:8px;text-align:center">
          Como obter: Meta for Developers → WhatsApp → Getting Started
        </p>
      </div>
    </div>
    <div class="settings-group">
      <div class="settings-label">Automações</div>
      <div style="padding:0 20px 12px">
        <div class="field">
          <label>Confirmação antes da aula (horas)</label>
          <select class="input" id="conf-hours">
            <option value="1" ${s.confirmationHours===1?'selected':''}>1 hora antes</option>
            <option value="2" ${s.confirmationHours===2?'selected':''}>2 horas antes</option>
            <option value="3" ${!s.confirmationHours||s.confirmationHours===3?'selected':''}>3 horas antes</option>
            <option value="6" ${s.confirmationHours===6?'selected':''}>6 horas antes</option>
            <option value="12" ${s.confirmationHours===12?'selected':''}>12 horas antes</option>
            <option value="24" ${s.confirmationHours===24?'selected':''}>24 horas antes</option>
          </select>
        </div>
        <div class="field" style="margin-top:12px">
          <label>Tempo para resposta da fila (horas)</label>
          <select class="input" id="wait-hours">
            <option value="0.5" ${s.waitlistResponseHours===0.5?'selected':''}>30 minutos</option>
            <option value="1" ${!s.waitlistResponseHours||s.waitlistResponseHours===1?'selected':''}>1 hora</option>
            <option value="2" ${s.waitlistResponseHours===2?'selected':''}>2 horas</option>
          </select>
        </div>
        <div class="field" style="margin-top:12px">
          <label>⭐ Mensalista: inscrição abre (horas antes da aula)</label>
          <select class="input" id="enroll-mens-hours">
            ${[6,12,24,48,72,168].map(h => `<option value="${h}" ${(s.enrollMensalistaHours??24)===h?'selected':''}>${h>=24?(h/24)+' dia'+(h>24?'s':''):h+' horas'} antes</option>`).join('')}
          </select>
        </div>
        <div class="field" style="margin-top:12px">
          <label>🎫 Avulso: inscrição abre (horas antes da aula)</label>
          <select class="input" id="enroll-av-hours">
            ${[3,6,12,24,48].map(h => `<option value="${h}" ${(s.enrollAvulsoHours??12)===h?'selected':''}>${h>=24?(h/24)+' dia'+(h>24?'s':''):h+' horas'} antes</option>`).join('')}
          </select>
        </div>
        <button class="btn btn-outline btn-full" style="margin-top:12px" id="btn-save-settings">Salvar automações</button>
      </div>
    </div>
    <div class="settings-group">
      <div class="settings-label">Conta</div>
      <div class="settings-item" onclick="logoutUser()">
        <div class="settings-icon si-red">🚪</div>
        <div class="flex-1"><div class="t-h3">Sair</div></div>
        <span class="settings-chevron">›</span>
      </div>
    </div>
  </div>`;
}

function attachAdminSettings() {
  const waRef = db.collection('arenas').doc(App.arenaId).collection('private').doc('whatsapp');

  // Config segura do WhatsApp (alunos não têm acesso a /private)
  waRef.get().then(snap => {
    const st = document.getElementById('wa-status');
    const d = snap.exists ? snap.data() : null;
    if (st) {
      st.className = `wa-status ${d?.token ? 'connected' : 'disconnected'}`;
      st.innerHTML = d?.token ? '<span>✅</span> WhatsApp conectado' : '<span>❌</span> WhatsApp não configurado';
    }
    const tk = document.getElementById('wa-token');
    const ph = document.getElementById('wa-phone-id');
    if (tk && d?.token) tk.value = d.token;
    if (ph && d?.phoneId) ph.value = d.phoneId;
  }).catch(()=>{});

  document.getElementById('btn-save-wa')?.addEventListener('click', async () => {
    const token = document.getElementById('wa-token')?.value.trim();
    const phoneId = document.getElementById('wa-phone-id')?.value.trim();
    if (!token || !phoneId) { showToast('Preencha token e Phone ID','error'); return; }
    showLoading();
    try {
      await waRef.set({ token, phoneId, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
      hideLoading();
      showToast('WhatsApp salvo com sucesso! ✅','success');
      App.go(SCREENS.A_SETTINGS);
    } catch(e) { hideLoading(); showToast('Erro ao salvar','error'); }
  });

  document.getElementById('btn-save-settings')?.addEventListener('click', async () => {
    const confH = parseFloat(document.getElementById('conf-hours')?.value);
    const waitH = parseFloat(document.getElementById('wait-hours')?.value);
    const mensH = parseInt(document.getElementById('enroll-mens-hours')?.value);
    const avH   = parseInt(document.getElementById('enroll-av-hours')?.value);
    showLoading();
    try {
      await db.collection('arenas').doc(App.arenaId).update({
        'settings.confirmationHours': confH,
        'settings.waitlistResponseHours': waitH,
        'settings.enrollMensalistaHours': mensH,
        'settings.enrollAvulsoHours': avH
      });
      App.arena = { ...App.arena,
        settings: { ...(App.arena?.settings||{}), confirmationHours: confH,
          waitlistResponseHours: waitH, enrollMensalistaHours: mensH, enrollAvulsoHours: avH } };
      hideLoading();
      showToast('Configurações salvas!','success');
    } catch(e) { hideLoading(); showToast('Erro ao salvar','error'); }
  });
}

window.editArenaInfo = function() {
  const a = App.arena || {};
  showModal({
    icon:'🏟️', iconBg:'var(--primary-dim)',
    title:'Informações da Arena',
    html:`<div style="display:flex;flex-direction:column;gap:12px;margin-top:16px">
      <input class="input" id="edit-arena-name" placeholder="Nome da arena" value="${a.name||''}">
      <input class="input" id="edit-arena-city" placeholder="Cidade" value="${a.city||''}">
      <input class="input" id="edit-arena-addr" placeholder="Endereço" value="${a.address||''}">
    </div>`,
    actions:[
      {label:'Cancelar', style:'btn-outline', close:true},
      {label:'Salvar', style:'btn-primary', id:'save-arena-info', close:true}
    ]
  });
  window._modalCallbacks['save-arena-info'] = async () => {
    const name = document.getElementById('edit-arena-name')?.value.trim();
    const city = document.getElementById('edit-arena-city')?.value.trim();
    const addr = document.getElementById('edit-arena-addr')?.value.trim();
    if (!name) { showToast('Nome obrigatório','error'); return; }
    try {
      await db.collection('arenas').doc(App.arenaId).update({name,city,address:addr});
      App.arena = {...App.arena, name, city, address:addr};
      showToast('Informações atualizadas!','success');
    } catch(e) { showToast('Erro','error'); }
  };
};

// ═══════════════════════════════════════════════════════════
//  SUPERADMIN — HOME
// ═══════════════════════════════════════════════════════════
function screenSAHome() {
  return `<div class="screen">
    <div class="topbar">
      <div>
        <div class="t-label t-dim">Superadmin</div>
        <div class="topbar-title">ArenaFlow 👑</div>
      </div>
      <div class="avatar avatar-md" style="background:linear-gradient(135deg,var(--primary),#6B4EFF);color:#fff">SA</div>
    </div>
    <div style="padding:0 20px 16px">
      <div class="mrr-hero">
        <div class="t-label t-dim" style="margin-bottom:8px">MRR — Receita Recorrente Mensal</div>
        <div class="mrr-value" id="sa-mrr">R$ —</div>
        <div class="t-sm t-muted" style="margin-top:6px" id="sa-mrr-sub">Calculando...</div>
      </div>
    </div>
    <div class="grid-2" style="padding:0 20px;gap:12px" id="sa-stats">
      <div class="stat-card primary"><div class="stat-value" id="sa-active">—</div><div class="stat-label">Arenas ativas</div></div>
      <div class="stat-card success"><div class="stat-value" id="sa-students">—</div><div class="stat-label">Alunos total</div></div>
      <div class="stat-card warning"><div class="stat-value" id="sa-overdue">—</div><div class="stat-label">Inadimplentes</div></div>
      <div class="stat-card accent"><div class="stat-value" id="sa-trial">—</div><div class="stat-label">Em trial</div></div>
    </div>
    <div id="sa-alerts" style="padding:16px 20px 0"></div>
    <div class="section-header" style="margin-top:8px">
      <span class="section-title">🏟️ Arenas recentes</span>
      <span class="section-action" onclick="App.go('${SCREENS.SA_ARENAS}')">Ver todas</span>
    </div>
    <div id="sa-recent-arenas"></div>
  </div>`;
}

function liveSAHome() {
  const unsub = db.collection('arenas').onSnapshot(snap => {
    let active=0, trial=0, overdue=0, totalStudents=0, totalMRR=0;
    let alerts = [];
    snap.docs.forEach(d => {
      const a = d.data();
      if (a.status==='active') active++;
      if (a.status==='trial') trial++;
      if (a.paymentStatus==='overdue') overdue++;
      totalStudents += a.studentCount||0;
      totalMRR += a.status==='active' ? (a.planValue||199) : 0;
      if (a.paymentStatus==='overdue') alerts.push({type:'danger', msg:`${a.name} — inadimplente há ${a.overdueDays||1} dias`});
      if (a.status==='trial') alerts.push({type:'warning', msg:`${a.name} — trial expira em breve`});
    });

    const mrr = document.getElementById('sa-mrr');
    const sub = document.getElementById('sa-mrr-sub');
    if (mrr) mrr.textContent = `R$ ${totalMRR.toLocaleString('pt-BR')}`;
    if (sub) sub.textContent = `${active} arenas ativas gerando receita`;

    const setEl = (id, val) => { const el=document.getElementById(id); if(el) el.textContent=val; };
    setEl('sa-active', active);
    setEl('sa-students', totalStudents);
    setEl('sa-overdue', overdue);
    setEl('sa-trial', trial);

    const al = document.getElementById('sa-alerts');
    if (al) al.innerHTML = alerts.slice(0,3).map(a =>
      `<div class="alert-banner ${a.type}" style="margin-bottom:8px">
        <span class="alert-banner-icon">${a.type==='danger'?'🔴':'🟡'}</span>
        <div class="alert-banner-text">${a.msg}</div>
      </div>`
    ).join('');

    const ra = document.getElementById('sa-recent-arenas');
    if (ra) ra.innerHTML = snap.docs.slice(0,4).map(d => {
      const a = d.data();
      const statusMap = {active:'badge-success', trial:'badge-warning', suspended:'badge-danger'};
      return `<div class="arena-row" onclick="App.go('${SCREENS.SA_ARENA}',{arenaId:'${d.id}'})">
        <div class="arena-icon">🏟️</div>
        <div class="flex-1">
          <div class="t-h3">${a.name||'—'}</div>
          <div class="t-xs t-muted">${a.city||'—'} • R$${a.planValue||199}/mês</div>
        </div>
        <span class="badge ${statusMap[a.status]||'badge-muted'}">${a.status||'—'}</span>
      </div>`;
    }).join('');
  });
  App.unsubscribers.push(unsub);
}

// ═══════════════════════════════════════════════════════════
//  SUPERADMIN — ARENAS LIST
// ═══════════════════════════════════════════════════════════
function screenSAArenas() {
  return `<div class="screen">
    <div class="topbar"><span class="topbar-title">🏟️ Arenas</span></div>
    <div class="search-bar">
      <span>🔍</span>
      <input type="search" placeholder="Buscar arena..." id="arena-search" oninput="filterArenas(this.value)">
    </div>
    <div id="arenas-list"></div>
    <button class="fab" onclick="App.go('${SCREENS.SA_NEW_ARENA}')">＋</button>
  </div>`;
}
window._allArenas = [];
window.filterArenas = function(q) {
  const f = window._allArenas.filter(a => a.name?.toLowerCase().includes(q.toLowerCase()) || a.city?.toLowerCase().includes(q.toLowerCase()));
  renderArenasList(f);
};

function liveSAArenas() {
  const unsub = db.collection('arenas').orderBy('name').onSnapshot(snap => {
    window._allArenas = snap.docs.map(d=>({id:d.id,...d.data()}));
    renderArenasList(window._allArenas);
  });
  App.unsubscribers.push(unsub);
}

function renderArenasList(arenas) {
  const list = document.getElementById('arenas-list');
  if (!list) return;
  if (!arenas.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-emoji">🏟️</div><div class="empty-title">Nenhuma arena</div><button class="btn btn-primary btn-sm" style="margin-top:12px" onclick="App.go('${SCREENS.SA_NEW_ARENA}')">Cadastrar arena</button></div>`;
    return;
  }
  const statusMap = {active:'badge-success', trial:'badge-warning', suspended:'badge-danger'};
  const statusLabel = {active:'Ativo', trial:'Trial', suspended:'Suspenso'};
  list.innerHTML = arenas.map(a =>
    `<div class="arena-row" onclick="App.go('${SCREENS.SA_ARENA}',{arenaId:'${a.id}'})">
     <div class="arena-icon" style="overflow:hidden;padding:0">
        ${a.photoBase64
          ? `<img src="${a.photoBase64}" style="width:100%;height:100%;object-fit:cover;border-radius:var(--r-sm)">`
          : `<span style="font-size:20px;display:flex;align-items:center;justify-content:center;height:100%">🏟️</span>`}
      </div>
      <div class="flex-1">
        <div class="t-h3">${a.name||'—'}</div>
        <div class="t-xs t-muted">${a.city||'—'} • ${a.gestorName||'—'}</div>
      </div>
      <div class="flex flex-col items-end gap-4">
        <span class="badge ${statusMap[a.status]||'badge-muted'}">${statusLabel[a.status]||a.status}</span>
        <span class="t-xs t-muted">R$${a.planValue||199}/mês</span>
      </div>
    </div>`
  ).join('');
}

// ═══════════════════════════════════════════════════════════
//  SUPERADMIN — ARENA DETAIL
// ═══════════════════════════════════════════════════════════
function screenSAArenaDetail() {
  return `<div class="screen">
    <div class="topbar">
      <button class="back-btn" onclick="App.go('${SCREENS.SA_ARENAS}')">←</button>
      <span class="topbar-title">Detalhes</span>
      <div></div>
    </div>
    <div id="sa-arena-body">
      <div class="empty-state"><div class="empty-emoji">⌛</div></div>
    </div>
  </div>`;
}

function liveAdminStudents() {
  if (App.screen === SCREENS.A_STUDENTS) {
    if (!App.arenaId) return;
    const unsub = db.collection('arenas').doc(App.arenaId)
      .collection('students')
      .onSnapshot(snap => {
        window._allStudents = snap.docs.map(d=>({id:d.id,...d.data()}));
        const active = window._allStudents.filter(s=>(s.status||'active')==='active');
        renderStudentList(active);
      });
    App.unsubscribers.push(unsub);
    return;
  }
  if (App.screen === SCREENS.SA_ARENA) {
    const arenaId = App.params?.arenaId;
    if (!arenaId) return;
    db.collection('arenas').doc(arenaId).get().then(snap => {
      if (!snap.exists) return;
      const a = snap.data();
      const body = document.getElementById('sa-arena-body');
      if (!body) return;
      const statusMap = {active:'badge-success', trial:'badge-warning', suspended:'badge-danger'};
      const statusLabel = {active:'Ativo', trial:'Trial', suspended:'Suspenso'};
      body.innerHTML = `
        <div style="padding:0 20px">
          <div class="card" style="margin-bottom:16px">
            <div class="flex items-center gap-12" style="margin-bottom:16px">
              <div class="arena-icon" style="width:56px;height:56px;font-size:26px;border-radius:14px">🏟️</div>
              <div>
                <div class="t-h2">${a.name||'—'}</div>
                <div class="t-sm t-muted">${a.city||'—'}${a.address?` • ${a.address}`:''}</div>
              </div>
            </div>
            <div class="grid-2">
              <div><div class="t-label t-dim">Gestor</div><div class="t-h3" style="margin-top:4px">${a.gestorName||'—'}</div></div>
              <div><div class="t-label t-dim">Status</div><div style="margin-top:4px"><span class="badge ${statusMap[a.status]||'badge-muted'}">${statusLabel[a.status]||'—'}</span></div></div>
              <div><div class="t-label t-dim">Plano</div><div class="t-h3" style="margin-top:4px">R$ ${a.planValue||199}/mês</div></div>
              <div><div class="t-label t-dim">Alunos</div><div class="t-h3" style="margin-top:4px">${a.studentCount||0}</div></div>
            </div>
          </div>

          <div class="card" style="margin-bottom:16px">
            <div class="t-label t-dim" style="margin-bottom:10px">👤 Dono da arena</div>
            <div class="t-h3">${a.gestorName||'—'}</div>
            <div class="t-sm t-muted">${a.gestorEmail||'—'}${a.gestorPhone?` • ${a.gestorPhone}`:''}</div>
            <div class="flex items-center gap-8" style="margin-top:10px">
              <span class="badge ${a.gestorUid?'badge-success':'badge-warning'}">${a.gestorUid?'✅ Convite resgatado':'⏳ Aguardando resgate'}</span>
              ${!a.gestorUid ? `<span class="t-sm t-dim">Código: <b>${a.inviteCode||'—'}</b></span>` : ''}
            </div>
            <div class="flex gap-8" style="margin-top:14px">
              <button class="btn btn-outline btn-sm flex-1" onclick="changeArenaGestor('${snap.id}')">✏️ Trocar dono</button>
              ${!a.gestorUid ? `<button class="btn btn-outline btn-sm flex-1" onclick="regenArenaInvite('${snap.id}')">🔄 Novo código</button>` : ''}
            </div>
            ${(a.staffEmails||[]).length ? `<div class="t-sm t-dim" style="margin-top:12px">Equipe: ${(a.staffEmails||[]).join(', ')}</div>` : ''}
          </div>

          <div class="flex gap-10">
            ${a.status==='active' ? `<button class="btn btn-danger flex-1" onclick="setArenaStatus('${snap.id}','suspended')">⛔ Suspender</button>` : ''}
            ${a.status==='suspended' ? `<button class="btn btn-success flex-1" onclick="setArenaStatus('${snap.id}','active')">✅ Reativar</button>` : ''}
            ${a.status==='trial' ? `<button class="btn btn-primary flex-1" onclick="setArenaStatus('${snap.id}','active')">✅ Ativar</button>` : ''}
            <button class="btn btn-outline flex-1" onclick="editArenaPlan('${snap.id}',${a.planValue||199})">💰 Editar plano</button>
          </div>
        </div>`;
    });
  }
}

// SA Arena detail live loader — separate from admin class
function liveSAArenaDetail() {
  liveAdminStudents(); // reuses SA_ARENA branch
}

window.setArenaStatus = async function(arenaId, status) {
  const labels = {active:'ativar', suspended:'suspender'};
  confirmModal(`${status==='suspended'?'Suspender':'Reativar'} arena?`,
    `Tem certeza que deseja ${labels[status]} esta arena?`,
    status==='suspended'?'⛔':'✅',
    async () => {
      showLoading();
      try {
        await db.collection('arenas').doc(arenaId).update({status});
        hideLoading();
        showToast(`Arena ${status==='suspended'?'suspensa':'reativada'}!`, status==='suspended'?'warning':'success');
        App.go(SCREENS.SA_ARENAS);
      } catch(e) { hideLoading(); showToast('Erro','error'); }
    }
  );
};

window.changeArenaGestor = async function(arenaId) {
  const snap = await db.collection('arenas').doc(arenaId).get();
  if (!snap.exists) return;
  const a = snap.data();
  showModal({
    icon:'✏️', iconBg:'var(--primary-dim)',
    title:'Trocar dono da arena',
    html:`<div style="margin-top:16px;text-align:left">
      <div class="field"><label>Nome do novo dono</label>
        <input class="input" id="ng-name" value=""></div>
      <div class="field" style="margin-top:10px"><label>E-mail (o que ele usará para logar)</label>
        <input class="input" id="ng-email" type="email" value=""></div>
      <div class="field" style="margin-top:10px"><label>Telefone</label>
        <input class="input" id="ng-phone" value=""></div>
      <div class="t-sm t-dim" style="margin-top:12px">⚠️ O dono atual (${a.gestorName||a.gestorEmail||'—'}) perde o acesso de gestão. Um novo código de convite será gerado.</div>
    </div>`,
    actions:[
      {label:'Cancelar', style:'btn-outline', close:true},
      {label:'Trocar dono', style:'btn-primary', id:'save-gestor', close:true}
    ]
  });
  window._modalCallbacks['save-gestor'] = async () => {
    const name  = document.getElementById('ng-name')?.value.trim();
    const email = document.getElementById('ng-email')?.value.trim().toLowerCase();
    const phone = document.getElementById('ng-phone')?.value.trim();
    if (!name || !email || !email.includes('@')) { showToast('Preencha nome e e-mail válidos','error'); return; }
    showLoading();
    try {
      const newCode = generateInviteCode();
      const oldUid = a.gestorUid || null;
      await db.collection('arenas').doc(arenaId).update({
        gestorName: name, gestorEmail: email, gestorPhone: phone || null,
        gestorUid: null, inviteCode: newCode
      });
      // Rebaixa o dono antigo (se já tinha resgatado o convite)
      if (oldUid) {
        await db.collection('users').doc(oldUid).update({
          role: 'student', arenaId: null,
          adminLevel: firebase.firestore.FieldValue.delete()
        }).catch(()=>{});
      }
      hideLoading();
      showModal({
        icon:'🔑', iconBg:'var(--success-dim)',
        title:'Dono alterado!',
        text:`Envie para ${name} (${email}): acesse o app → "Tenho um convite de gestor" → código ${newCode}`,
        actions:[{label:'Copiar código', style:'btn-primary', id:'copy-gcode', close:true},
                 {label:'Fechar', style:'btn-outline', close:true}]
      });
      window._modalCallbacks['copy-gcode'] = () => {
        navigator.clipboard?.writeText(newCode).then(()=>showToast('Código copiado!','success'));
      };
      App.go(SCREENS.SA_ARENA, {arenaId});
    } catch(e) { hideLoading(); showToast('Erro ao trocar dono','error'); }
  };
};

window.regenArenaInvite = async function(arenaId) {
  confirmModal('Gerar novo código?','O código de convite atual deixa de funcionar.','🔄', async () => {
    showLoading();
    try {
      const newCode = generateInviteCode();
      await db.collection('arenas').doc(arenaId).update({ inviteCode: newCode });
      hideLoading();
      showToast(`Novo código: ${newCode}`,'success');
      App.go(SCREENS.SA_ARENA, {arenaId});
    } catch(e) { hideLoading(); showToast('Erro','error'); }
  });
};

window.editArenaPlan = function(arenaId, currentValue) {
  showModal({
    icon:'💰', iconBg:'var(--primary-dim)',
    title:'Editar plano',
    html:`<div style="margin-top:16px">
      <input class="input" id="plan-value" type="number" value="${currentValue}" min="0">
    </div>`,
    actions:[
      {label:'Cancelar', style:'btn-outline', close:true},
      {label:'Salvar', style:'btn-primary', id:'save-plan', close:true}
    ]
  });
  window._modalCallbacks['save-plan'] = async () => {
    const val = parseInt(document.getElementById('plan-value')?.value);
    if (!val && val!==0) return;
    try {
      await db.collection('arenas').doc(arenaId).update({planValue:val});
      showToast('Plano atualizado!','success');
    } catch(e) { showToast('Erro','error'); }
  };
};

// ═══════════════════════════════════════════════════════════
//  SUPERADMIN — NEW ARENA
// ═══════════════════════════════════════════════════════════
function screenSANewArena() {
  return `<div class="screen">
    <div class="topbar">
      <button class="back-btn" onclick="App.go('${SCREENS.SA_ARENAS}')">←</button>
      <span class="topbar-title">Nova Arena</span>
      <div></div>
    </div>
    <div style="padding:16px 20px;display:flex;flex-direction:column;gap:16px">
      <div class="field"><label>Nome da Arena</label><input class="input" id="na-name" placeholder="Arena Beira Mar"></div>
      <div class="grid-2">
        <div class="field"><label>Cidade</label><input class="input" id="na-city" placeholder="Rio de Janeiro"></div>
        <div class="field"><label>Estado</label><input class="input" id="na-state" placeholder="RJ" maxlength="2"></div>
      </div>
      <div class="field"><label>Endereço</label><input class="input" id="na-addr" placeholder="Rua, número, bairro"></div>
      <div style="height:1px;background:var(--border)"></div>
      <p class="t-label t-dim">Dados do Gestor</p>
      <div class="field"><label>Nome do gestor</label><input class="input" id="na-gname" placeholder="Nome completo"></div>
      <div class="field"><label>E-mail do gestor</label><input class="input" id="na-gemail" type="email" placeholder="gestor@arena.com"></div>
      <div class="field"><label>Telefone</label><input class="input" id="na-gphone" type="tel" placeholder="(21) 99999-9999"></div>
      <div style="height:1px;background:var(--border)"></div>
      <p class="t-label t-dim">Plano</p>
      <div class="grid-2">
        <div class="field">
          <label>Tipo</label>
          <select class="input" id="na-plan">
            <option value="trial">Trial (14 dias)</option>
            <option value="monthly">Mensal</option>
          </select>
        </div>
        <div class="field">
          <label>Valor (R$)</label>
          <input class="input" id="na-value" type="number" value="199" min="0">
        </div>
      </div>
      <button class="btn btn-primary btn-full btn-lg" id="btn-create-arena">🏟️ Cadastrar arena</button>
    </div>
  </div>`;
}

function attachSANewArena() {
  document.getElementById('btn-create-arena')?.addEventListener('click', async () => {
    const name   = document.getElementById('na-name')?.value.trim();
    const city   = document.getElementById('na-city')?.value.trim();
    const state  = document.getElementById('na-state')?.value.trim().toUpperCase();
    const addr   = document.getElementById('na-addr')?.value.trim();
    const gname  = document.getElementById('na-gname')?.value.trim();
    const gemail = document.getElementById('na-gemail')?.value.trim();
    const gphone = document.getElementById('na-gphone')?.value.trim();
    const plan   = document.getElementById('na-plan')?.value;
    const value  = parseInt(document.getElementById('na-value')?.value);
    if (!name||!city||!gname||!validateEmail(gemail)) { showToast('Preencha todos os campos obrigatórios','error'); return; }
    showLoading();
    try {
      // Create the arena in Firestore
      // Note: gestor account is created separately by the gestor
  const inviteCode = generateInviteCode();
      const studentCode = generateInviteCode();
      await db.collection('arenas').add({
        name, city: `${city}${state?'/'+state:''}`, address:addr,
        gestorName:gname, gestorEmail:gemail, gestorPhone:gphone,
        status: plan==='trial' ? 'trial' : 'active',
        plan, planValue: value||199,
        studentCount: 0, paymentStatus: 'pending',
        inviteCode,
        studentCode,
        gestorUid: null,
        settings: { confirmationHours:3, waitlistResponseHours:1,
                    enrollMensalistaHours:24, enrollAvulsoHours:12 },
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      hideLoading();
      confetti();
      showModal({
        icon:'🏟️', iconBg:'var(--success-dim)',
        title:'Arena cadastrada!',
        text:`${name} criada! Código de convite do gestor: 🔑 ${inviteCode} — envie para ${gemail}.`,
        actions:[{label:'Ótimo!', style:'btn-success', close:true}],
        onClose: () => App.go(SCREENS.SA_ARENAS)
      });
    } catch(e) { hideLoading(); showToast('Erro ao cadastrar','error'); }
  });
}

// ═══════════════════════════════════════════════════════════
//  SUPERADMIN — FINANCIAL
// ═══════════════════════════════════════════════════════════
function screenSAFinancial() {
  return `<div class="screen">
    <div class="topbar"><span class="topbar-title">💰 Financeiro</span></div>
    <div id="financial-body" style="padding:0 20px">
      <div class="empty-state"><div class="empty-emoji">⌛</div></div>
    </div>
  </div>`;
}

function liveSAFinancial() {
  if (App.screen === SCREENS.SA_FINANCIAL) {
    db.collection('arenas').get().then(snap => {
      const body = document.getElementById('financial-body');
      if (!body) return;
      let total=0, overdue=0;
      const rows = snap.docs.map(d => {
        const a = d.data();
        if (a.status==='active') total += a.planValue||199;
        if (a.paymentStatus==='overdue') overdue += a.planValue||199;
        const ps = a.paymentStatus||'pending';
        const psb = {paid:'badge-success', pending:'badge-warning', overdue:'badge-danger'}[ps]||'badge-muted';
        return `<div class="arena-row" style="cursor:default">
          <div class="flex-1">
            <div class="t-h3">${a.name||'—'}</div>
            <div class="t-xs t-muted">R$${a.planValue||199}/mês</div>
          </div>
          <span class="badge ${psb}">${ps==='paid'?'Em dia':ps==='overdue'?'Atrasado':'Pendente'}</span>
        </div>`;
      }).join('');
      body.innerHTML = `
        <div class="mrr-hero" style="margin:16px 0">
          <div class="t-label t-dim">MRR Total</div>
          <div class="mrr-value">R$ ${total.toLocaleString('pt-BR')}</div>
          ${overdue ? '<div class="t-sm" style="color:var(--danger);margin-top:6px">R$ ' + overdue.toLocaleString('pt-BR') + ' em inadimplência</div>' : ''}
        </div>
        <div style="background:var(--card);border-radius:var(--r-lg);overflow:hidden;border:1px solid var(--border)">
          ${rows||'<div class="t-muted t-center" style="padding:24px">Nenhuma arena</div>'}
        </div>`;
    });
  }
}

// ═══════════════════════════════════════════════════════════
//  SUPERADMIN — SETTINGS
// ═══════════════════════════════════════════════════════════
function screenSASettings() {
  return `<div class="screen">
    <div class="topbar"><span class="topbar-title">⚙️ Configurações</span></div>
    <div class="settings-group">
      <div class="settings-label">Plataforma</div>
      <div class="settings-item"><div class="settings-icon si-blue">💰</div><div class="flex-1"><div class="t-h3">Planos disponíveis</div></div><span class="settings-chevron">›</span></div>
      <div class="settings-item"><div class="settings-icon si-orange">📱</div><div class="flex-1"><div class="t-h3">Mensagens padrão</div></div><span class="settings-chevron">›</span></div>
    </div>
    <div class="settings-group">
      <div class="settings-label">Conta</div>
      <div class="settings-item" onclick="logoutUser()">
        <div class="settings-icon si-red">🚪</div>
        <div class="flex-1"><div class="t-h3">Sair</div></div>
        <span class="settings-chevron">›</span>
      </div>
    </div>
    <div style="padding:24px 20px;text-align:center">
      <div class="logo-mark" style="width:52px;height:52px;font-size:22px;border-radius:16px;margin:0 auto 12px">AF</div>
      <div class="t-sm t-muted">ArenaFlow v1.0</div>
      <div class="t-xs t-dim">by você 👑</div>
    </div>
  </div>`;
}

// ═══════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════

function generateInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random()*chars.length)];
  return code;
}
function toLocalDateStr(date) {
  const d = date ? new Date(date) : new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function getWeekDays() {
  const days = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
  const result = [];
  const today = new Date();
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    result.push({
      iso:  toLocalDateStr(d),
      name: i===0 ? 'Hoje' : days[d.getDay()],
      num:  d.getDate()
    });
  }
  return result;
}

// Check badges for student after attending class
async function checkAndAwardBadges(uid, arenaId) {
  try {
    const snap = await db.collection('users').doc(uid).get();
    if (!snap.exists) return;
    const profile = snap.data();
    const earned = profile.badges || [];
    const total = profile.totalClasses || 0;
    const streakWeeks = profile.streakWeeks || 0;
    const newBadges = [];

    BADGES.forEach(b => {
      if (earned.includes(b.id)) return;
      if (b.type === 'classes' && total >= b.req) newBadges.push(b);
      if (b.type === 'streak_weeks' && streakWeeks >= b.req) newBadges.push(b);
    });

    if (newBadges.length > 0) {
      await db.collection('users').doc(uid).update({
        badges: firebase.firestore.FieldValue.arrayUnion(...newBadges.map(b=>b.id))
      });
      // Update student in arena
      if (arenaId) {
        await db.collection('arenas').doc(arenaId).collection('students').doc(uid).update({
          badges: firebase.firestore.FieldValue.arrayUnion(...newBadges.map(b=>b.id))
        });
        // Add to community feed
        for (const b of newBadges) {
          await db.collection('arenas').doc(arenaId).collection('feed').add({
            type: 'badge', authorId: uid, authorName: profile.name,
            text: `conquistou o emblema ${b.emoji} ${b.name}!`,
            reactions: {},
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
          });
        }
      }
      // Show badge unlock animation
      newBadges.forEach((b, i) => {
        setTimeout(() => {
          confetti();
          showModal({
            icon: b.emoji, iconBg:'var(--primary-dim)',
            title:'Novo Emblema!',
            text:'Você conquistou: ' + b.name,
            actions:[{label:'Incrível! 🎉', style:'btn-success', close:true}]
          });
        }, i * 1500);
      });
    }
  } catch(e) { console.error('Badge check error:', e); }
}

// ── INIT ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  App.init();
  document.getElementById('loading-overlay').innerHTML = `<div class="spinner"></div>`;
  showLoading();
});
// ── FIM DO ARQUIVO ──────────────────────────────────────────
