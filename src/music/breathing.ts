// How arrangements breathe: principles from public songwriting and production resources
// (Open Music Theory, Secrets of Songwriting, Ableton's Making Music, Soundfly, Sound On Sound …),
// in our own words. Shown in the coach; the generator applies many of them (src/music/generate/arrange.ts).

export const BREATHING_GUIDE: string[] = [
  '編曲裡的「呼吸」就是一收一放：主歌先收著講故事，導歌（Pre-chorus）開始吸氣，副歌把氣吐出來。整首歌的能量大方向要往上走，但中途一定要安排幾次往下的小坡，一路衝到底反而讓人聽得很累。',
  '能量不等於音量。有四個旋鈕可以一起轉：力度（Velocity）、同時演奏的樂器數量、音域高低、節奏密度。副歌應該比主歌更「滿、高、密」，而不只是把音量推大。',
  '主歌要讓位給人聲：伴奏簡單一點、樂器少一點，不要在人聲的音域裡塞忙碌的線條。有旋律感的小樂句，留到人聲換氣的空檔再出現。',
  '一問一答（Call and response）：人聲唱完一句，就讓吉他、鍵盤或管樂「回一句」——在最後一個字唱完之後才進來，下一句開口前就結束，最後落在和弦的根音或三音上。空檔短就回一兩個音，空檔長才回一個小樂句；歌曲越往後，回應可以越多。',
  '樂句就是換氣的單位：大多是 4 小節一句、8 或 16 小節一段。鼓的過門放在句尾或段尾的最後一拍到最後一小節，下一段第一拍打一下 Crash 鈸，讓聽眾清楚感覺到「換段了」。過門要有變化，不要每次都一樣。',
  '大爆發之前先憋氣：副歌或 Drop 之前的最後一拍到一小節，把鼓和貝斯（甚至全部樂器）抽掉，下一拍全員一起回來，衝擊感會強很多。',
  '導歌是上坡路：旋律切成短句、和弦換得更快、離開主和弦，最後停在屬和弦（V）不解決；力度慢慢漸強，小鼓可以越打越密。',
  '第二段主歌要比第一段多一點點東西：加一個輕打擊樂或 Hi-hat、把和弦補滿、加一條反旋律或和聲，或是把和弦的音域往上移。重點是「多一點變化」，而不是只把音量開大。',
  '第一次副歌的最後一兩小節可以稍微收一下（或接一小段前奏的重現），讓第二段主歌能從比較低的地方重新爬坡，而不是突然垮掉。',
  '橋段（Bridge）負責轉折：換一組不在主和弦上的和聲、換一種織度或能量，也可以拿來放獨奏；通常結束在屬和弦，把期待留給最後的副歌。如果整首歌一直都很滿，橋段就適合抽空；否則就繼續往上堆。',
  '最後的副歌要「更上一層樓」：加入一直保留到現在才出現的新聲部、把旋律或和聲往上移、加即興人聲（Ad-lib），也可以把副歌重複兩次或升半音／全音。進最後副歌之前先收一下再爆發，效果更好；升調很好用，但不要濫用。',
  '張力與放鬆：持續低音（Pedal）、掛留和弦（sus）、停在屬和弦、切分音、越來越密的節奏、漸強和上升音效（Riser）都是在「拉緊」；回到主和弦、回到正拍、長音、變小聲則是在「放鬆」。',
  '音域越高，情緒越強：副歌的旋律通常比主歌高，最高的音留給最重要的段落；旋律慢慢往上爬再落下，比一直停在同一個高度更有期待感。旋律往上、貝斯往下的反向進行也很有戲劇性。',
  '同時出現的角色不要太多：節奏基礎（鼓＋貝斯）、鋪底的 Pad、節奏樂器、主旋律、過門，大約四種同時出現就夠，超過五種耳朵就會亂。每個聲部要有自己的音域位置，和弦別擠進貝斯的低音區，太低的密集和弦會變得混濁。',
  '讓樂器一個一個進場：前奏和 Build 大約每 4 或 8 小節加一個元素，尾奏和 Breakdown 則反過來一個一個拿掉。也可以先做出最滿的那一段，再往前用「減法」編出其他段落。',
  '人性化不是亂數：重拍和反拍（第 2、4 拍）力度強，弱拍和十六分音符較輕，幽靈音（Ghost note）更輕；小鼓稍微晚一點點（幾毫秒）會有慵懶的律動感，但偏移太多聽起來就像打錯。',
  '搖擺（Swing）可以用百分比來想：50% 是直拍，54% 只是稍微放鬆，58–62% 是常見的鬆弛律動，66% 是完整的三連音搖擺。爵士的慢歌搖擺比例比較大，快歌則越來越接近平均。',
  '結尾也要好好吐氣：重複最後的副歌或主題，同時慢慢抽掉樂器或淡出；或者乾脆俐落地停在主和弦上。',
  '不同曲風有不同的呼吸法：抒情曲從很少的樂器開始慢慢加，把最大的情緒留給最後的副歌；搖滾用安靜的主歌對比爆裂的副歌；嘻哈在 16 小節裡以 4 小節為單位抽掉大鼓；EDM 在 Drop 前抽掉低頻、留一拍空白；爵士用 Trading fours 和 Stop-time 讓樂手輪流說話。',
];

export const BREATHING_SOURCES: { title: string; url: string }[] = [
  { title: 'Open Music Theory：Formal functions in pop/rock form（CC BY-SA 4.0）', url: 'https://github.com/openmusictheory/openmusictheory.github.io/blob/master/popRockForm-functions.md' },
  { title: 'Open Music Theory：Formal containers and module structures（CC BY-SA 4.0）', url: 'https://github.com/openmusictheory/openmusictheory.github.io/blob/master/popRockForm-containers.md' },
  { title: 'Secrets of Songwriting（Gary Ewer）：Designing the Energy Level of your Song', url: 'https://www.secretsofsongwriting.com/2009/04/23/designing-the-energy-level-of-your-song/' },
  { title: 'Secrets of Songwriting：The Difference Between Verse 1 and Verse 2', url: 'https://www.secretsofsongwriting.com/2009/09/07/the-difference-between-verse-1-and-verse-2/' },
  { title: 'Ableton Making Music（Dennis DeSantis）：Arranging as a Subtractive Process', url: 'https://makingmusic.ableton.com/arranging-as-a-subtractive-process' },
  { title: 'Soundfly Flypaper：Scaffolding — Map Out the Energy Flow of Your Song', url: 'https://flypaper.soundfly.com/write/scaffolding-song-structure/' },
  { title: 'Sound On Sound：Making Arrangements, Part 1', url: 'https://www.soundonsound.com/techniques/making-arrangements-part-1' },
  { title: 'Guitar Player：Guitar Fills — What to Play When Your Singer Shuts Up', url: 'https://www.guitarplayer.com/lessons/guitar-fills-what-to-play-when-your-singer-shuts-up' },
  { title: 'Musical U：Tension and Release in Music', url: 'https://www.musical-u.com/learn/tension-in-music/' },
  { title: 'Wikipedia：Break (music)、Breakdown (music)、Drop (music)（CC BY-SA 4.0）', url: 'https://en.wikipedia.org/wiki/Break_(music)' },
];
