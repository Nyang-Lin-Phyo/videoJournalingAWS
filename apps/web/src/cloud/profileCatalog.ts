// Stable ids shared with infra/lambda/user_profile.py. Keep both lists in sync.
export type ChoiceOption = { id: string; label: string };

export const INTEREST_OPTIONS: ChoiceOption[] = [
  { id: "walking", label: "Walks" },
  { id: "hiking", label: "Hiking & nature" },
  { id: "running", label: "Running" },
  { id: "gym", label: "Gym & workouts" },
  { id: "yoga", label: "Yoga & stretching" },
  { id: "cycling", label: "Cycling" },
  { id: "sports", label: "Team sports" },
  { id: "dancing", label: "Dancing" },
  { id: "cooking", label: "Cooking & baking" },
  { id: "reading", label: "Reading" },
  { id: "writing", label: "Writing" },
  { id: "art", label: "Drawing & painting" },
  { id: "photography", label: "Photography" },
  { id: "playing_music", label: "Playing music" },
  { id: "gaming", label: "Gaming" },
  { id: "movies", label: "Movies & TV" },
  { id: "gardening", label: "Gardening" },
  { id: "pets", label: "Pets" },
  { id: "friends", label: "Time with friends" },
  { id: "family", label: "Family time" },
  { id: "travel", label: "Travel" },
  { id: "meditation", label: "Meditation" },
  { id: "volunteering", label: "Volunteering" },
  { id: "coffee", label: "Coffee shops" },
  { id: "learning", label: "Learning new things" },
  { id: "coding", label: "Tech & coding" },
];

export const MUSIC_OPTIONS: ChoiceOption[] = [
  { id: "pop", label: "Pop" },
  { id: "hiphop", label: "Hip-hop" },
  { id: "rnb", label: "R&B" },
  { id: "rock", label: "Rock" },
  { id: "indie", label: "Indie" },
  { id: "electronic", label: "Electronic" },
  { id: "lofi", label: "Lo-fi" },
  { id: "jazz", label: "Jazz" },
  { id: "classical", label: "Classical" },
  { id: "country", label: "Country" },
  { id: "kpop", label: "K-pop" },
  { id: "bollywood", label: "Bollywood" },
  { id: "latin", label: "Latin" },
  { id: "metal", label: "Metal" },
  { id: "folk", label: "Folk" },
  { id: "ambient", label: "Ambient" },
  { id: "soul", label: "Soul" },
];

export const MOOD_BOOSTER_OPTIONS: ChoiceOption[] = [
  { id: "walking", label: "A walk" },
  { id: "being_outside", label: "Fresh air" },
  { id: "listening_music", label: "Music" },
  { id: "gym", label: "A workout" },
  { id: "running", label: "A run" },
  { id: "yoga", label: "Stretching or yoga" },
  { id: "meditation", label: "Slow breathing" },
  { id: "friends", label: "Seeing friends" },
  { id: "family", label: "Family" },
  { id: "talking", label: "Talking it out" },
  { id: "pets", label: "A pet" },
  { id: "cooking", label: "Cooking" },
  { id: "reading", label: "A good book" },
  { id: "gaming", label: "Gaming" },
  { id: "movies", label: "A comfort show" },
  { id: "art", label: "Making something" },
  { id: "writing", label: "Writing it down" },
  { id: "rest", label: "Rest or a nap" },
  { id: "bath", label: "A warm shower" },
];

export const COMFORT_FOOD_OPTIONS: ChoiceOption[] = [
  { id: "ice_cream", label: "Ice cream" },
  { id: "chocolate", label: "Chocolate" },
  { id: "pizza", label: "Pizza" },
  { id: "tea", label: "Tea" },
  { id: "chai", label: "Chai" },
  { id: "coffee", label: "Coffee" },
  { id: "hot_chocolate", label: "Hot chocolate" },
  { id: "soup", label: "Warm soup" },
  { id: "noodles", label: "Noodles" },
  { id: "biryani", label: "Biryani" },
  { id: "dumplings", label: "Dumplings" },
  { id: "fries", label: "Fries" },
  { id: "cookies", label: "Cookies" },
  { id: "cake", label: "Cake" },
  { id: "pasta", label: "Pasta" },
  { id: "lemonade", label: "Lemonade" },
  { id: "smoothie", label: "Smoothie" },
  { id: "fruit", label: "Fresh fruit" },
  { id: "boba", label: "Bubble tea" },
  { id: "home_cooking", label: "Home cooking" },
];

export const MAX_INTERESTS = 10;
export const MAX_MUSIC = 6;
export const MAX_MOOD_BOOSTERS = 5;
export const MAX_COMFORT_FOODS = 6;
export const MAX_MUSIC_NOTE = 80;
