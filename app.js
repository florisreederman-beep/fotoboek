// =====================================================================
// APP.JS: alles wat de website "doet".
// HTML = de bouwtekening, CSS = de verf, JavaScript = de elektriciteit.
// =====================================================================

// Verbinding maken met jouw Supabase-project (gegevens uit config.js)
const db = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

let currentUser = null;     // wie is er ingelogd?
let currentProfile = null;  // diens profiel (gebruikersnaam, host of niet)

// Kort hulpje: $('feed') = het element met id="feed"
const $ = (id) => document.getElementById(id);

// Hulpje om HTML-elementen te maken. We gebruiken textContent i.p.v.
// innerHTML, zodat niemand via een reactie code in je site kan stoppen.
function el(tag, props = {}, children = []) {
  const element = document.createElement(tag);
  Object.assign(element, props);
  for (const child of [].concat(children)) {
    if (child) element.append(child);
  }
  return element;
}

function showMessage(text, isError = false) {
  const box = $('message');
  box.textContent = text;
  box.className = isError ? 'error' : 'info';
  box.hidden = false;
  clearTimeout(showMessage.timer);
  showMessage.timer = setTimeout(() => (box.hidden = true), 6000);
}


// ---------------------------------------------------------------------
// 1. ACCOUNTS: registreren, inloggen, uitloggen
// ---------------------------------------------------------------------

$('show-signup').onclick = () => { $('login-form').hidden = true;  $('signup-form').hidden = false; };
$('show-login').onclick  = () => { $('signup-form').hidden = true; $('login-form').hidden = false; };

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault(); // voorkom dat de pagina herlaadt
  const { error } = await db.auth.signInWithPassword({
    email: $('login-email').value.trim(),
    password: $('login-password').value,
  });
  if (error) showMessage('Inloggen mislukt: ' + error.message, true);
});

$('signup-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const { data, error } = await db.auth.signUp({
    email: $('signup-email').value.trim(),
    password: $('signup-password').value,
    options: { data: { username: $('signup-username').value.trim() } },
  });
  if (error) return showMessage('Registreren mislukt: ' + error.message, true);
  if (!data.session) {
    showMessage('Gelukt! Check je e-mail om je account te bevestigen.');
  }
});

$('logout-button').onclick = () => db.auth.signOut();

// Supabase laat het weten zodra iemand in- of uitlogt (ook bij het openen
// van de pagina). Dan wisselen we van scherm.
db.auth.onAuthStateChange((_event, session) => {
  setTimeout(() => handleSession(session), 0);
});

async function handleSession(session) {
  currentUser = session ? session.user : null;

  if (!currentUser) {
    currentProfile = null;
    $('auth-view').hidden = false;
    $('app-view').hidden = true;
    $('user-bar').hidden = true;
    return;
  }

  const { data } = await db
    .from('profiles')
    .select('username, is_host')
    .eq('id', currentUser.id)
    .single();
  currentProfile = data;

  $('auth-view').hidden = true;
  $('app-view').hidden = false;
  $('user-bar').hidden = false;
  $('user-name').textContent = (data ? data.username : currentUser.email) + (isHost() ? ' (host)' : '');
  $('upload-form').hidden = !isHost();

  loadFeed();
}

function isHost() {
  return Boolean(currentProfile && currentProfile.is_host);
}


// ---------------------------------------------------------------------
// 2. FOTO'S POSTEN (alleen host)
// ---------------------------------------------------------------------

$('upload-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = $('photo-input').files[0];
  if (!file) return;

  const button = $('upload-button');
  button.disabled = true;
  button.textContent = 'Bezig met uploaden...';

  // Unieke bestandsnaam, zodat foto's elkaar nooit overschrijven
  const extension = file.name.split('.').pop().toLowerCase();
  const path = `${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`;

  // Stap A: bestand naar de opslag
  const upload = await db.storage.from('photos').upload(path, file);

  // Stap B: rij in de tabel "posts"
  let error = upload.error;
  if (!error) {
    const insert = await db.from('posts').insert({
      image_path: path,
      caption: $('caption-input').value.trim() || null,
    });
    error = insert.error;
    if (error) await db.storage.from('photos').remove([path]); // opruimen
  }

  button.disabled = false;
  button.textContent = 'Posten';

  if (error) return showMessage('Posten mislukt: ' + error.message, true);
  $('upload-form').reset();
  showMessage('Foto geplaatst!');
  loadFeed();
});

async function deletePost(post) {
  if (!confirm('Deze foto echt verwijderen?')) return;
  const { error } = await db.from('posts').delete().eq('id', post.id);
  if (error) return showMessage('Verwijderen mislukt: ' + error.message, true);
  await db.storage.from('photos').remove([post.image_path]);
  loadFeed();
}


// ---------------------------------------------------------------------
// 3. DE FEED: alle foto's met likes en reacties ophalen en tonen
// ---------------------------------------------------------------------

async function loadFeed() {
  // Eén vraag aan de database: posts, met hun likes en reacties
  // (en bij elke reactie de gebruikersnaam van de schrijver).
  const { data: posts, error } = await db
    .from('posts')
    .select(`
      id, image_path, caption, created_at,
      likes ( user_id ),
      comments ( id, content, created_at, user_id, profiles ( username ) )
    `)
    .order('created_at', { ascending: false })
    .order('created_at', { referencedTable: 'comments', ascending: true });

  const feed = $('feed');
  feed.replaceChildren();

  if (error) return showMessage('Feed laden mislukt: ' + error.message, true);
  if (posts.length === 0) {
    feed.append(el('p', { className: 'empty', textContent: 'Nog geen foto\'s. ' + (isHost() ? 'Post de eerste hierboven!' : 'Kom later terug!') }));
    return;
  }

  for (const post of posts) feed.append(renderPost(post));
}

function formatDate(isoString) {
  return new Date(isoString).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' });
}

function renderPost(post) {
  const imageUrl = db.storage.from('photos').getPublicUrl(post.image_path).data.publicUrl;
  const likedByMe = post.likes.some((like) => like.user_id === currentUser.id);

  // Like-knop
  const likeButton = el('button', {
    type: 'button',
    className: 'like-button' + (likedByMe ? ' liked' : ''),
    textContent: `${likedByMe ? '♥' : '♡'} ${post.likes.length}`,
    title: likedByMe ? 'Like weghalen' : 'Liken',
    onclick: () => toggleLike(post.id, likedByMe),
  });

  // Reacties
  const commentList = el('ul', { className: 'comments' },
    post.comments.map((comment) => {
      const canDelete = comment.user_id === currentUser.id || isHost();
      return el('li', {}, [
        el('strong', { textContent: (comment.profiles ? comment.profiles.username : 'onbekend') + ' ' }),
        el('span', { textContent: comment.content }),
        canDelete && el('button', {
          type: 'button', className: 'link-button small', textContent: 'verwijder',
          onclick: () => deleteComment(comment.id),
        }),
      ]);
    })
  );

  // Formulier om te reageren
  const commentInput = el('input', { type: 'text', placeholder: 'Schrijf een reactie...', maxLength: 500, required: true });
  const commentForm = el('form', { className: 'comment-form' }, [
    commentInput,
    el('button', { type: 'submit', textContent: 'Plaats' }),
  ]);
  commentForm.addEventListener('submit', (event) => {
    event.preventDefault();
    addComment(post.id, commentInput.value.trim());
  });

  return el('article', { className: 'card post' }, [
    el('img', { src: imageUrl, alt: post.caption || 'Foto', loading: 'lazy' }),
    el('div', { className: 'post-body' }, [
      el('div', { className: 'post-actions' }, [
        likeButton,
        el('span', { className: 'date', textContent: formatDate(post.created_at) }),
        isHost() && el('button', {
          type: 'button', className: 'link-button small danger', textContent: 'Foto verwijderen',
          onclick: () => deletePost(post),
        }),
      ]),
      post.caption && el('p', { className: 'caption', textContent: post.caption }),
      commentList,
      commentForm,
    ]),
  ]);
}


// ---------------------------------------------------------------------
// 4. LIKEN EN REAGEREN
// ---------------------------------------------------------------------

async function toggleLike(postId, likedByMe) {
  const { error } = likedByMe
    ? await db.from('likes').delete().eq('post_id', postId).eq('user_id', currentUser.id)
    : await db.from('likes').insert({ post_id: postId });
  if (error) return showMessage('Liken mislukt: ' + error.message, true);
  loadFeed();
}

async function addComment(postId, text) {
  if (!text) return;
  const { error } = await db.from('comments').insert({ post_id: postId, content: text });
  if (error) return showMessage('Reageren mislukt: ' + error.message, true);
  loadFeed();
}

async function deleteComment(commentId) {
  const { error } = await db.from('comments').delete().eq('id', commentId);
  if (error) return showMessage('Verwijderen mislukt: ' + error.message, true);
  loadFeed();
}
