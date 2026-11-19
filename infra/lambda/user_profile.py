"""Shared USERS-table profile logic for the results API and the queue worker.

A profile row (key ``userId`` = Cognito ``sub``) holds two independent parts:

* Stated preferences, from onboarding and the Interests tab: ``interests``,
  ``music``, ``musicNote``, ``moodBoosters``, ``comfortFoods`` and the
  ``onboardingCompleted`` flag. Only the results API writes these, and only
  these are ever returned to the user.
* Learned data, built by the worker from journal transcripts: ``learned``
  (favourites with mood effect and the situations they go with),
  ``learnedTopics``, ``recommendationLog``, ``learnedFrom`` and
  ``learnedVersion``. Admin-side only; never returned by a user-facing route.

Each writer updates only its own attributes, so the API and the worker never
overwrite each other's data.

Favourites have a kind: ``activity``, ``food`` (food or drink) or ``music``.
Learned keys are ``"<kind>:<slug>"``, e.g. ``food:lemonade``.

Ranking principle: observed behaviour outweighs stated preferences. One
observed mood lift outranks anything picked at sign-up, and a favourite that
repeatedly coincides with low mood is dropped even if the user picked it.

Recommendations have three triggers: ``comfort`` (a sad entry),
``context_match`` (today's situation matches a favourite's learned
situations, e.g. sunny -> lemonade) and ``been_a_while`` (a well-liked
favourite not mentioned for a while; randomly gated so it stays occasional).
Gemini writes the text; ``choose_recommendation`` verifies it server-side.
"""
import math
import random
import re
from datetime import date, datetime, timezone
from decimal import Decimal

ONBOARDING_VERSION = 1
KINDS = ('activity', 'food', 'music')

# Stable ids are shared with apps/web/src/cloud/profileCatalog.ts. Keep in sync.
ACTIVITIES = {
    'walking': 'going for a walk',
    'hiking': 'hiking or time in nature',
    'being_outside': 'getting some fresh air outside',
    'running': 'running',
    'gym': 'a workout',
    'yoga': 'yoga or stretching',
    'cycling': 'cycling',
    'sports': 'playing sports',
    'dancing': 'dancing',
    'cooking': 'cooking or baking',
    'reading': 'reading',
    'writing': 'writing',
    'art': 'drawing or painting',
    'photography': 'photography',
    'playing_music': 'playing music',
    'listening_music': 'listening to music',
    'gaming': 'gaming',
    'movies': 'a movie or show',
    'gardening': 'gardening',
    'pets': 'time with a pet',
    'friends': 'time with friends',
    'family': 'time with family',
    'talking': 'talking it through with someone',
    'travel': 'travel or exploring somewhere new',
    'meditation': 'meditation or breathing',
    'volunteering': 'volunteering',
    'coffee': 'a coffee shop break',
    'learning': 'learning something new',
    'coding': 'a tech or coding project',
    'rest': 'rest or a nap',
    'bath': 'a warm shower or bath',
}
FOODS = {
    'ice_cream': 'ice cream',
    'chocolate': 'chocolate',
    'pizza': 'pizza',
    'tea': 'a cup of tea',
    'chai': 'chai',
    'coffee': 'a coffee',
    'hot_chocolate': 'hot chocolate',
    'soup': 'a warm soup',
    'noodles': 'noodles',
    'biryani': 'biryani',
    'dumplings': 'dumplings',
    'fries': 'fries',
    'cookies': 'cookies',
    'cake': 'cake',
    'pasta': 'pasta',
    'lemonade': 'lemonade',
    'smoothie': 'a smoothie',
    'fruit': 'fresh fruit',
    'boba': 'bubble tea',
    'home_cooking': 'a home-cooked meal',
}
INTEREST_IDS = frozenset({
    'walking', 'hiking', 'running', 'gym', 'yoga', 'cycling', 'sports', 'dancing',
    'cooking', 'reading', 'writing', 'art', 'photography', 'playing_music', 'gaming',
    'movies', 'gardening', 'pets', 'friends', 'family', 'travel', 'meditation',
    'volunteering', 'coffee', 'learning', 'coding',
})
MOOD_BOOSTER_IDS = frozenset({
    'walking', 'being_outside', 'listening_music', 'gym', 'running', 'yoga',
    'meditation', 'friends', 'family', 'talking', 'pets', 'cooking', 'reading',
    'gaming', 'movies', 'art', 'writing', 'rest', 'bath',
})
MUSIC_IDS = {
    'pop': 'pop', 'hiphop': 'hip-hop', 'rnb': 'R&B', 'rock': 'rock',
    'indie': 'indie', 'electronic': 'electronic', 'lofi': 'lo-fi',
    'jazz': 'jazz', 'classical': 'classical', 'country': 'country',
    'kpop': 'K-pop', 'bollywood': 'Bollywood', 'latin': 'Latin',
    'metal': 'metal', 'folk': 'folk', 'ambient': 'ambient', 'soul': 'soul',
}
# Situations a favourite can be associated with, and that a transcript can describe.
CONTEXT_TAGS = (
    'sunny', 'hot', 'rainy', 'cold', 'snowy', 'morning', 'evening', 'late_night',
    'weekend', 'workday', 'stressed', 'tired', 'celebrating', 'lonely',
    'with_friends', 'exams', 'after_exercise', 'holiday', 'bored',
)
CONTEXT_SET = frozenset(CONTEXT_TAGS)

MAX_INTERESTS = 10
MAX_MUSIC = 6
MAX_MOOD_BOOSTERS = 5
MAX_COMFORT_FOODS = 6
MAX_MUSIC_NOTE = 80

# Learning parameters.
LEARNED_HALF_LIFE_DAYS = 60.0
MAX_LEARNED_ITEMS = 60
MAX_LEARNED_FROM = 50
MAX_SIGNALS_PER_JOURNAL = 6
MAX_CONTEXTS_PER_SIGNAL = 3
LOWERS_WEIGHT = 0.75
OBSERVED_WEIGHT = 2.0
STATED_BOOSTER_PRIOR = 1.0
STATED_FOOD_PRIOR = 1.0
STATED_NOTE_PRIOR = 0.8
STATED_INTEREST_PRIOR = 0.5
STATED_GENRE_PRIOR = 0.4
DROP_NET = -1.0           # Observed net score at/below which an item is dropped.
DROP_MIN_EVIDENCE = 2.0   # ...but only once there is enough evidence.
SLUG_RE = re.compile(r'^[a-z0-9][a-z0-9_]{1,39}$')
EFFECTS = ('lifts_mood', 'lowers_mood', 'neutral')
# Signal quality gates.
MIN_CONFIDENCE = 0.4          # Below this (after grounding) a signal is ignored.
UNGROUNDED_PENALTY = 0.5      # Evidence not found verbatim in the transcript.
NOT_HAPPENED_MENTION = 0.5    # Planned/wished-for items: a weak mention only.
MAX_EVIDENCE_WORDS = 25
# Recurring topics learned from the reflection's themes.
MAX_LEARNED_TOPICS = 30
MAX_THEMES_PER_JOURNAL = 8
MAX_PROMPT_TOPICS = 5
TOPIC_RE = re.compile(r'^[a-z][a-z_]{1,39}$')
# Recommendations.
MAX_PROMPT_FAVOURITES = 8
CONTEXT_MIN_WEIGHT = 0.8      # One confident mention links a favourite to a situation.
BEEN_A_WHILE_DAYS = 14
BEEN_A_WHILE_MIN_SCORE = 1.0
NUDGE_MIN_GAP_DAYS = 2        # No unprompted nudge within 2 days of the last suggestion.
NUDGE_PROBABILITY = 0.5       # ...and then only on about half of eligible entries.
REPEAT_BLOCK_DAYS = 3         # The same item is not re-suggested for 3 days (except comfort).
RECENT_SUGGESTION_DAYS = 7
MAX_RECOMMENDATION_LOG = 12
MAX_SUGGESTION_CHARS = 400
REASONS = ('comfort', 'context_match', 'been_a_while')


class ProfileError(ValueError):
    """A client-visible profile validation error."""


# --------------------------------------------------------------------------
# Stated preferences (API)
# --------------------------------------------------------------------------

def _id_list(raw, allowed, limit, field):
    if raw is None:
        return []
    if not isinstance(raw, list) or len(raw) > limit:
        raise ProfileError(f'{field} must be a list of at most {limit} choices')
    seen = []
    for value in raw:
        if not isinstance(value, str) or value not in allowed:
            raise ProfileError(f'{field} contains an unknown choice')
        if value not in seen:
            seen.append(value)
    return seen


def clean_music_note(raw):
    if raw is None:
        return ''
    if not isinstance(raw, str):
        raise ProfileError('music_note must be text')
    note = ' '.join(raw.split())
    if len(note) > MAX_MUSIC_NOTE or any(ord(c) < 32 or ord(c) == 127 for c in note):
        raise ProfileError(f'music_note must be at most {MAX_MUSIC_NOTE} visible characters')
    return note


def validate_stated(body):
    """Validate a PUT /profile body; returns DynamoDB-ready stated attributes."""
    if not isinstance(body, dict):
        raise ProfileError('Expected a JSON object')
    allowed = {'interests', 'music', 'mood_boosters', 'comfort_foods', 'music_note',
               'complete_onboarding'}
    if set(body) - allowed:
        raise ProfileError('Unexpected profile field')
    complete = body.get('complete_onboarding', False)
    if not isinstance(complete, bool):
        raise ProfileError('complete_onboarding must be true or false')
    return {
        'interests': _id_list(body.get('interests'), INTEREST_IDS, MAX_INTERESTS, 'interests'),
        'music': _id_list(body.get('music'), MUSIC_IDS, MAX_MUSIC, 'music'),
        'moodBoosters': _id_list(body.get('mood_boosters'), MOOD_BOOSTER_IDS,
                                 MAX_MOOD_BOOSTERS, 'mood_boosters'),
        'comfortFoods': _id_list(body.get('comfort_foods'), FOODS, MAX_COMFORT_FOODS,
                                 'comfort_foods'),
        'musicNote': clean_music_note(body.get('music_note')),
    }, complete


def public_profile(item):
    """The only profile view a user ever receives. Learned data is excluded."""
    item = item or {}
    completed = bool(item.get('onboardingCompleted')) and int(
        item.get('onboardingVersion', 0)) >= ONBOARDING_VERSION
    return {
        'onboarding_completed': completed,
        'interests': [v for v in item.get('interests', []) if v in INTEREST_IDS],
        'music': [v for v in item.get('music', []) if v in MUSIC_IDS],
        'mood_boosters': [v for v in item.get('moodBoosters', []) if v in MOOD_BOOSTER_IDS],
        'comfort_foods': [v for v in item.get('comfortFoods', []) if v in FOODS],
        'music_note': item.get('musicNote', '') or '',
    }


# --------------------------------------------------------------------------
# Cleaning model output
# --------------------------------------------------------------------------

def _slug(raw, max_words):
    words = re.findall(r'[a-z0-9]+', raw.lower())
    if not 1 <= len(words) <= max_words:
        return None
    slug = '_'.join(words)
    return slug if SLUG_RE.fullmatch(slug) else None


def _catalog_id(raw, catalog):
    text = raw.strip().lower()
    slug = re.sub(r'_+', '_', re.sub(r'[\s\-]+', '_', text)).strip('_')
    if slug in catalog:
        return slug
    for item_id, description in catalog.items():
        if text in (description, description.removeprefix('a ').removeprefix('an ')):
            return item_id
    return None


def normalize_activity(raw):
    """Map a model-produced activity label to a safe snake_case id, or None."""
    return normalize_item('activity', raw)


def normalize_item(kind, raw):
    """Map a model-produced label of a kind to a safe slug, or None."""
    if not isinstance(raw, str) or kind not in KINDS:
        return None
    if kind == 'activity':
        return _catalog_id(raw, ACTIVITIES) or _slug(raw, 3)
    if kind == 'food':
        return _catalog_id(raw, FOODS) or _slug(raw, 3)
    return _catalog_id(raw, MUSIC_IDS) or _slug(raw, 5)


def display_name(raw):
    """A short, prompt-safe display name for non-catalog items (artists, dishes)."""
    if not isinstance(raw, str):
        return ''
    name = ' '.join(re.sub(r"[^A-Za-z0-9 &'.\-]", ' ', raw).split())
    return name[:40] if 1 <= len(name.split()) <= 6 else ''


def item_name(key, stats=None):
    kind, _, slug = key.partition(':')
    catalog = {'activity': ACTIVITIES, 'food': FOODS, 'music': MUSIC_IDS}.get(kind, {})
    if slug in catalog:
        return catalog[slug]
    name = (stats or {}).get('name') if isinstance(stats, dict) else None
    return name or slug.replace('_', ' ')


def _words(text):
    return re.findall(r"[a-z0-9']+", text.lower())


def is_grounded(evidence, transcript):
    """True when the quote appears word for word (ignoring case/punctuation)."""
    if not isinstance(evidence, str) or not isinstance(transcript, str):
        return False
    quote = _words(evidence)
    if not 2 <= len(quote) <= MAX_EVIDENCE_WORDS:
        return False
    return f" {' '.join(quote)} " in f" {' '.join(_words(transcript))} "


def clean_contexts(raw, limit=MAX_CONTEXTS_PER_SIGNAL):
    if not isinstance(raw, list):
        return []
    tags = []
    for tag in raw:
        if isinstance(tag, str) and tag in CONTEXT_SET and tag not in tags:
            tags.append(tag)
    return tags[:limit]


def clean_signals(raw, transcript=None):
    """Validate the model's profile_signals.

    Returns dicts {key, kind, name, effect, weight, happened, contexts}. weight
    is the model's confidence, halved when its evidence quote is not found in
    the transcript (a hallucination guard); signals under MIN_CONFIDENCE are
    dropped. The evidence quote is only used for this check and never stored.
    """
    if not isinstance(raw, list):
        return []
    cleaned = {}
    for entry in raw[:MAX_SIGNALS_PER_JOURNAL * 2]:
        if not isinstance(entry, dict):
            continue
        kind = entry.get('kind', 'activity')
        label = entry.get('item', entry.get('activity'))
        slug = normalize_item(kind, label)
        effect = entry.get('effect')
        if not slug or effect not in EFFECTS:
            continue
        key = f'{kind}:{slug}'
        if key in cleaned:
            continue
        confidence = entry.get('confidence', 1.0 if transcript is None else 0.0)
        if isinstance(confidence, bool) or not isinstance(confidence, (int, float)):
            continue
        weight = min(max(float(confidence), 0.0), 1.0)
        if transcript is not None and not is_grounded(entry.get('evidence'), transcript):
            weight *= UNGROUNDED_PENALTY
        if not math.isfinite(weight) or weight < MIN_CONFIDENCE:
            continue
        happened = entry.get('happened', True)
        if not isinstance(happened, bool):
            continue
        cleaned[key] = {
            'key': key, 'kind': kind, 'name': display_name(label), 'effect': effect,
            'weight': round(weight, 3), 'happened': happened,
            'contexts': clean_contexts(entry.get('contexts')),
        }
        if len(cleaned) >= MAX_SIGNALS_PER_JOURNAL:
            break
    return list(cleaned.values())


# --------------------------------------------------------------------------
# Learning
# --------------------------------------------------------------------------

def _as_float(value, default=0.0):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def _decay(days):
    return 0.5 ** (max(days, 0) / LEARNED_HALF_LIFE_DAYS)


def _parse_day(raw):
    try:
        return date.fromisoformat(raw)
    except (TypeError, ValueError):
        return None


def _squash(label):
    return label.replace('_', '')


def _valid_key(key):
    kind, sep, slug = str(key).partition(':')
    return bool(sep) and kind in KINDS and bool(SLUG_RE.fullmatch(slug))


def canonical_key(key, existing):
    """Reuse an existing learned/catalog key that differs only by underscores."""
    kind, _, slug = key.partition(':')
    catalog = {'activity': ACTIVITIES, 'food': FOODS, 'music': MUSIC_IDS}[kind]
    if key in existing or slug in catalog:
        return key
    squashed = _squash(slug)
    for other in existing:
        other_kind, _, other_slug = other.partition(':')
        if other_kind == kind and _squash(other_slug) == squashed:
            return other
    for other_slug in catalog:
        if _squash(other_slug) == squashed:
            return f'{kind}:{other_slug}'
    return key


def merge_learned(learned, signals, today):
    """Return an updated learned map after applying one journal's signals.

    Counts and situation links decay with a 60-day half-life so recent
    behaviour matters most. Planned/wished-for items never count as mood or
    situation evidence. Stored as Decimal for DynamoDB.
    """
    merged = {}
    for key, stats in (learned or {}).items():
        if not isinstance(stats, dict) or not _valid_key(key):
            continue
        merged[key] = {
            'kind': key.partition(':')[0],
            'name': stats.get('name', '') if isinstance(stats.get('name', ''), str) else '',
            'lifts': _as_float(stats.get('lifts')),
            'lowers': _as_float(stats.get('lowers')),
            'mentions': _as_float(stats.get('mentions')),
            'contexts': {tag: _as_float(w) for tag, w in (stats.get('contexts') or {}).items()
                         if tag in CONTEXT_SET},
            'lastSeen': stats.get('lastSeen') or today.isoformat(),
        }
    for signal in signals:
        key = canonical_key(signal['key'], merged)
        weight = signal['weight']
        stats = merged.get(key) or {
            'kind': key.partition(':')[0], 'name': '', 'lifts': 0.0, 'lowers': 0.0,
            'mentions': 0.0, 'contexts': {}, 'lastSeen': today.isoformat(),
        }
        factor = _decay((today - (_parse_day(stats['lastSeen']) or today)).days)
        for field in ('lifts', 'lowers', 'mentions'):
            stats[field] *= factor
        stats['contexts'] = {tag: w * factor for tag, w in stats['contexts'].items()}
        if not stats['name'] and signal.get('name') and key.partition(':')[2] not in (
                ACTIVITIES if stats['kind'] == 'activity' else FOODS if stats['kind'] == 'food' else MUSIC_IDS):
            stats['name'] = signal['name']
        if not signal['happened']:
            # Intentions ("I should go to the gym") never count as evidence.
            stats['mentions'] += weight * NOT_HAPPENED_MENTION
        else:
            stats['mentions'] += weight
            if signal['effect'] == 'lifts_mood':
                stats['lifts'] += weight
            elif signal['effect'] == 'lowers_mood':
                stats['lowers'] += weight
            if signal['effect'] != 'lowers_mood':
                for tag in signal.get('contexts', []):
                    stats['contexts'][tag] = stats['contexts'].get(tag, 0.0) + weight
            stats['lastSeen'] = today.isoformat()
        merged[key] = stats
    if len(merged) > MAX_LEARNED_ITEMS:
        def strength(entry):
            _, s = entry
            age = (today - (_parse_day(s['lastSeen']) or today)).days
            return (s['lifts'] + s['lowers'] + s['mentions']) * _decay(age)
        merged = dict(sorted(merged.items(), key=strength, reverse=True)[:MAX_LEARNED_ITEMS])
    dec = lambda value: Decimal(str(round(value, 3)))  # noqa: E731
    return {
        key: {
            'kind': s['kind'],
            'name': s['name'],
            'lifts': dec(s['lifts']),
            'lowers': dec(s['lowers']),
            'mentions': dec(s['mentions']),
            'contexts': {tag: dec(w) for tag, w in s['contexts'].items() if w >= 0.05},
            'lastSeen': s['lastSeen'],
        }
        for key, s in merged.items()
    }


def normalize_topic(raw):
    if not isinstance(raw, str):
        return None
    words = re.findall(r'[a-z]+', raw.lower())
    if not 1 <= len(words) <= 3:
        return None
    topic = '_'.join(words)
    return topic if TOPIC_RE.fullmatch(topic) else None


def merge_topics(learned_topics, themes, today):
    """Decayed counts of recurring themes (what they often talk about)."""
    merged = {}
    for topic, stats in (learned_topics or {}).items():
        if isinstance(stats, dict) and TOPIC_RE.fullmatch(str(topic)):
            merged[topic] = {'weight': _as_float(stats.get('weight')),
                             'lastSeen': stats.get('lastSeen') or today.isoformat()}
    seen = set()
    for theme in list(themes or [])[:MAX_THEMES_PER_JOURNAL]:
        topic = normalize_topic(theme)
        if not topic:
            continue
        topic = next((key for key in merged if _squash(key) == _squash(topic)), topic)
        if topic in seen:
            continue
        seen.add(topic)
        stats = merged.get(topic, {'weight': 0.0, 'lastSeen': today.isoformat()})
        last = _parse_day(stats['lastSeen']) or today
        merged[topic] = {'weight': stats['weight'] * _decay((today - last).days) + 1,
                         'lastSeen': today.isoformat()}

    def current(entry):
        _, stats = entry
        return stats['weight'] * _decay((today - (_parse_day(stats['lastSeen']) or today)).days)
    merged = dict(sorted(merged.items(), key=current, reverse=True)[:MAX_LEARNED_TOPICS])
    return {topic: {'weight': Decimal(str(round(stats['weight'], 3))), 'lastSeen': stats['lastSeen']}
            for topic, stats in merged.items()}


def recurring_topics(item, today=None, limit=MAX_PROMPT_TOPICS):
    """Topics that came up in about two or more recent journals, strongest first."""
    today = today or datetime.now(timezone.utc).date()
    scored = []
    for topic, stats in ((item or {}).get('learnedTopics') or {}).items():
        if not isinstance(stats, dict) or not TOPIC_RE.fullmatch(str(topic)):
            continue
        last = _parse_day(stats.get('lastSeen')) or today
        weight = _as_float(stats.get('weight')) * _decay((today - last).days)
        if weight >= 1.5:
            scored.append((weight, topic))
    scored.sort(key=lambda value: (-value[0], value[1]))
    return [topic.replace('_', ' ') for _, topic in scored[:limit]]


# --------------------------------------------------------------------------
# Ranking and recommendations
# --------------------------------------------------------------------------

def rank_favourites(item, today=None, limit=MAX_PROMPT_FAVOURITES):
    """Rank favourites (activities, food/drink, music), behaviour first.

    Returns [{'item', 'kind', 'name', 'from', 'good_moments',
    'last_mentioned_days_ago', 'score'}]. Observed lifts carry OBSERVED_WEIGHT
    per (decayed) event, so one observed lift outranks any stated preference;
    favourites whose observed net effect is clearly negative are dropped.
    """
    item = item or {}
    today = today or datetime.now(timezone.utc).date()
    scores = {}
    for key, stats in (item.get('learned') or {}).items():
        if not isinstance(stats, dict) or not _valid_key(key):
            continue
        last = _parse_day(stats.get('lastSeen')) or today
        factor = _decay((today - last).days)
        lifts = _as_float(stats.get('lifts')) * factor
        lowers = _as_float(stats.get('lowers')) * factor
        net = lifts - LOWERS_WEIGHT * lowers
        contexts = sorted(
            ((w * factor, tag) for tag, w in
             ((t, _as_float(v)) for t, v in (stats.get('contexts') or {}).items())
             if tag in CONTEXT_SET and w * factor >= CONTEXT_MIN_WEIGHT),
            reverse=True)
        scores[key] = {
            'observed': net * OBSERVED_WEIGHT, 'stated': 0.0, 'net': net,
            'evidence': lifts + lowers, 'name': item_name(key, stats),
            'contexts': [tag for _, tag in contexts[:3]],
            'days': (today - last).days,
        }

    def add_stated(key, prior, name=None):
        entry = scores.setdefault(key, {'observed': 0.0, 'stated': 0.0, 'net': 0.0, 'evidence': 0.0,
                                        'name': name or item_name(key), 'contexts': [], 'days': None})
        entry['stated'] = max(entry['stated'], prior)
    for value in item.get('moodBoosters', []) or []:
        if value in MOOD_BOOSTER_IDS:
            add_stated(f'activity:{value}', STATED_BOOSTER_PRIOR)
    for value in item.get('comfortFoods', []) or []:
        if value in FOODS:
            add_stated(f'food:{value}', STATED_FOOD_PRIOR)
    for value in item.get('interests', []) or []:
        if value in INTEREST_IDS:
            add_stated(f'activity:{value}', STATED_INTEREST_PRIOR)
    for value in item.get('music', []) or []:
        if value in MUSIC_IDS:
            add_stated(f'music:{value}', STATED_GENRE_PRIOR)
    note = item.get('musicNote') or ''
    note_slug = _slug(note, 5) if isinstance(note, str) else None
    if note_slug and display_name(note):
        add_stated(f'music:{note_slug}', STATED_NOTE_PRIOR, display_name(note))

    ranked = []
    for key, entry in scores.items():
        if entry['net'] <= DROP_NET and entry['evidence'] >= DROP_MIN_EVIDENCE:
            continue  # Behaviour overrides what they said they like.
        total = entry['observed'] + entry['stated']
        if total <= 0:
            continue
        ranked.append((total, key, entry))
    ranked.sort(key=lambda value: (-value[0], value[1]))
    return [
        {
            'item': key,
            'kind': key.partition(':')[0],
            'name': entry['name'],
            'from': 'observed' if entry['observed'] > 0 else 'stated',
            'good_moments': entry['contexts'],
            'last_mentioned_days_ago': entry['days'],
            'score': round(total, 3),
        }
        for total, key, entry in ranked[:limit]
    ]


def rank_mood_helpers(item, today=None, limit=5):
    """Backward-compatible alias: top favourites with their source."""
    return [{'activity': fav['item'].partition(':')[2], 'kind': fav['kind'],
             'description': fav['name'], 'source': fav['from']}
            for fav in rank_favourites(item, today, limit)]


def recent_recommendations(item, today, days=RECENT_SUGGESTION_DAYS):
    recent = []
    for entry in (item or {}).get('recommendationLog', []) or []:
        day = _parse_day(entry.get('day')) if isinstance(entry, dict) else None
        if day and 0 <= (today - day).days < days and isinstance(entry.get('item'), str):
            recent.append({'item': entry['item'], 'days_ago': (today - day).days})
    return recent


def nudge_allowed(item, upload_id, today):
    """Occasional, unprompted nudges: at least a 2-day gap, then ~50% chance.

    Seeded by upload id so SQS retries make the same decision.
    """
    last = None
    for entry in (item or {}).get('recommendationLog', []) or []:
        day = _parse_day(entry.get('day')) if isinstance(entry, dict) else None
        if day and (last is None or day > last):
            last = day
    if last and (today - last).days < NUDGE_MIN_GAP_DAYS:
        return False
    return random.Random(str(upload_id)).random() < NUDGE_PROBABILITY


def prompt_context(item, today=None, allow_nudge=False):
    """Bounded, sanitized profile context for the Gemini prompt (or None)."""
    if not item:
        return None
    today = today or datetime.now(timezone.utc).date()
    favourites = rank_favourites(item, today)
    topics = recurring_topics(item, today)
    music = [MUSIC_IDS[v] for v in item.get('music', []) or [] if v in MUSIC_IDS]
    try:
        note = clean_music_note(item.get('musicNote') or '')
    except ProfileError:
        note = ''
    if not favourites and not music and not note and not topics:
        return None
    been_a_while = [
        fav['item'] for fav in favourites
        if fav['from'] == 'observed' and fav['score'] >= BEEN_A_WHILE_MIN_SCORE
        and (fav['last_mentioned_days_ago'] or 0) >= BEEN_A_WHILE_DAYS
    ]
    recent = {entry['item'] for entry in recent_recommendations(item, today)}
    return {
        'favourites': [{k: v for k, v in fav.items() if k != 'score'} for fav in favourites],
        'music_they_enjoy': music,
        'favourite_artist_or_song': note,
        'recurring_topics': topics,
        'recently_suggested': sorted(recent),
        'uplift_nudge_allowed': bool(allow_nudge and been_a_while),
        'been_a_while': been_a_while if allow_nudge else [],
    }


def choose_recommendation(raw, sentiment, context, today, profile=None):
    """Server-side check of the model's recommendation; returns dict or None.

    * comfort: only for negative entries; item must be a known favourite, or
      empty (a general kind idea) only when there are no favourites.
    * context_match: item must be a favourite whose learned good moments
      overlap the situations the model saw in today's transcript.
    * been_a_while: only when a nudge was allowed and the item was offered.
    Non-comfort items suggested in the last REPEAT_BLOCK_DAYS are refused.
    """
    if not isinstance(raw, dict):
        return None
    text = ' '.join(str(raw.get('text') or '').split())[:MAX_SUGGESTION_CHARS]
    reason = raw.get('reason')
    item_key = raw.get('item') if isinstance(raw.get('item'), str) else ''
    if not text or reason not in REASONS:
        return None
    favourites = {fav['item']: fav for fav in (context or {}).get('favourites', [])}
    if item_key and item_key not in favourites:
        return None
    if reason == 'comfort':
        if sentiment != 'negative' or (not item_key and favourites):
            return None
        return {'text': text, 'reason': reason, 'item': item_key}
    if not item_key:
        return None
    blocked = {entry['item'] for entry in recent_recommendations(profile, today, REPEAT_BLOCK_DAYS)}
    if item_key in blocked:
        return None
    if reason == 'context_match':
        today_tags = set(clean_contexts(raw.get('today_context'), len(CONTEXT_TAGS)))
        if not today_tags & set(favourites[item_key].get('good_moments', [])):
            return None
        return {'text': text, 'reason': reason, 'item': item_key}
    if not (context or {}).get('uplift_nudge_allowed') or item_key not in context.get('been_a_while', []):
        return None
    return {'text': text, 'reason': reason, 'item': item_key}


def log_recommendation(log, recommendation, today):
    entries = [entry for entry in (log or []) if isinstance(entry, dict)]
    if recommendation:
        entries.append({'item': recommendation['item'] or 'general',
                        'reason': recommendation['reason'], 'day': today.isoformat()})
    return entries[-MAX_RECOMMENDATION_LOG:]
