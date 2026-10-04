# The TTS Studio format (version 1)

A plain-text format for listening material: dialogues, monologues and single
sentences. You write a file; it is imported into TTS Studio, where each item
becomes a script that can be played line by line with Google Cloud voices.

A complete, working example is [examples/listening-pack.txt](examples/listening-pack.txt).

```text
#tts-studio 1
@lang fr-FR

## Au café
@speaker Serveur: male
@speaker Claire: female

Serveur: Bonjour madame, qu'est-ce que je vous sers ?
> Good morning, madam. What can I get you?
Claire: Un café crème, s'il vous plaît. [1] Et un croissant.
> A white coffee, please. And a croissant.

## Dictée 1
Il fait beau aujourd'hui, mais demain il va pleuvoir.
> It is nice today, but tomorrow it is going to rain.
```

## The rules

A file is read line by line. What a line does depends only on how it starts:

| A line starting with | is | Example |
| --- | --- | --- |
| `#tts-studio 1` | the header, the first line of every file | `#tts-studio 1` |
| `##` | the start of a new item, with its title | `## Au café` |
| `@` | a setting | `@speaker Claire: female` |
| `>` | the translation of the line above it, never read aloud | `> Hello!` |
| `#` | a comment, ignored | `# check this one with Marie` |
| anything else | a spoken line | `Claire: Bonjour !` |

Blank lines are ignored, so use them freely to separate things. Settings for an
item go between its `##` heading and its first spoken line.

## Three kinds of item

### A dialogue: several people

Declare every speaker, then start every line with the speaker's name and a
colon.

```text
## À la boulangerie
@speaker Boulangère: female
@speaker Client: male

Boulangère: Bonjour monsieur, vous désirez ?
Client: Une baguette, s'il vous plaît.
Boulangère: Et avec ceci ?
```

There is no limit on the number of speakers.

### A monologue: one person

No names are needed. Either leave the cast out entirely, and a narrator voice
reads everything, or declare the one speaker to choose the voice:

```text
## Annonce en gare
@speaker Annonce: female

Mesdames et messieurs, le train à destination de Lyon partira voie 5.
Attention : le quai est glissant.
```

Each line is still played separately, so a learner can repeat any one of them.

### A single sentence

An item with one line:

```text
## Dictée 1
Il fait beau aujourd'hui, mais demain il va pleuvoir.
```

For a **set** of unrelated sentences (a dictation series, useful phrases), prefer
one item with one sentence per line over one item per sentence: it keeps the
library tidy, and each sentence is still played, repeated and shadowed on its
own.

```text
## Phrases utiles
Je voudrais réserver une table pour deux.
Où se trouve la gare, s'il vous plaît ?
L'addition, s'il vous plaît.
```

### Why speakers must be declared

French puts a space before a colon, so `Attention : le quai est glissant.` looks
exactly like a speaker called "Attention". A name only counts as a speaker when
it is declared with `@speaker`, so ordinary sentences are never mistaken for
dialogue.

One convenience: if an item declares no one, but **every** line starts with a
name and there are at least two different names, those names are taken as the
speakers and given voices automatically. The importer says when it does this.
Declaring them is still better, because it lets you choose who is male and who
is female.

## Speakers

```text
@speaker Claire: female
@speaker Paul: male Charon
@speaker Narrateur: Kore
@speaker Madame Dupont
```

After the name and the colon, you may give a gender, a voice, both, or nothing:

- **Gender:** `female` or `male` (`f`, `m`, `femme`, `homme`, `女` and `男` work too).
  The speaker gets an unused voice of that gender.
- **Voice:** one of the 30 names listed at the end of this page, in any case.
- **Nothing:** a voice is chosen automatically, alternating male and female so
  that two speakers never sound alike.

The same file always gets the same voices, so re-importing it is predictable.

Names can have spaces and accents, up to 24 characters, but no colon and no
square brackets. In the lines, the name is matched regardless of case, and the
French space before the colon is fine: `Claire : Bonjour !` works.

### Directions (Gemini only)

With the `gemini` engine, a speaker can be given a direction in plain words:

```text
@engine gemini
@speaker Léa: female
@direction Léa: agacée, parle vite
```

Chirp 3: HD ignores directions.

## Settings

| Setting | Meaning | Default |
| --- | --- | --- |
| `@lang fr-FR` | Language of the item. | `fr-FR` |
| `@engine chirp3-hd` | Voice engine: `chirp3-hd` or `gemini`. | `chirp3-hd` |
| `@model gemini-2.5-pro-tts` | Gemini model, with the `gemini` engine only. | `gemini-2.5-flash-tts` |
| `@id cafe-01` | A stable identifier for the item. | none |
| `@speaker Name: …` | A speaker, see above. | |
| `@direction Name: …` | A Gemini direction, see above. | |

`@lang`, `@engine` and `@model` can also go **above the first heading**, where
they apply to every item in the file; an item can still override them.

**Use `@id` for material you will revise.** When a file is imported again, an
item whose id is already in the library replaces it instead of being added a
second time. Ids may contain letters, digits, `.`, `-` and `_`, and must be
unique in the file.

Languages: `fr-FR`, `fr-CA`, `en-US`, `en-GB`, `es-ES`, `de-DE`, `it-IT`,
`pt-BR`, `ja-JP`, `ko-KR` and many more. The complete list for each engine is at
`/api/catalog` on the TTS Studio site.

## Inside a line

**Pauses.** `[1.5]` or `[pause 2]` inserts that many seconds of silence:

```text
Serveur: Le code est sur le ticket. [1] Et voilà, ça fait quatre euros.
```

**Abbreviations.** In French scripts, TTS Studio reads common abbreviations
in full: `Mme`, `M.`, `Dr`, `qch`, `qn`, `p. ex.`, `svp` and others are read as
*Madame*, *Monsieur*, *Docteur*, *quelque chose*, *quelqu'un*, *par exemple*,
*s'il vous plaît*. The text on screen keeps the abbreviation. The full list is
under **Dictionary**, where rules can be switched off or added.

**Gemini markup tags.** With the `gemini` engine, tags such as `[sigh]`,
`[laughing]`, `[whispering]`, `[short pause]` or `[long pause]` change the
delivery. Chirp 3: HD would read them aloud, and the importer warns about that.

## Translations

A line starting with `>` is attached to the spoken line above it. It is shown
under that line in TTS Studio and is never read aloud. Translations are
optional, can be in any language, and can span several `>` lines:

```text
Claire: Bonjour ! Un café crème, s'il vous plaît.
> 你好！请来一杯奶油咖啡。
> (crème = with milk)
```

## Checking a file

Open TTS Studio, go to **Library → Import scripts…**, and paste the file or
drop it in. Every problem is listed with its line number, and clicking one
selects that line. Nothing is imported until there are no errors, so this is
also the way to check a file before sending it.

There are two levels:

- **Problems** must be fixed: an undeclared speaker, a misspelt voice, a line
  with no speaker in a dialogue, text before the first heading.
- **Notes** are worth reading but do not block the import: a declared speaker
  who never speaks, a Gemini tag on Chirp, a missing header.

A misspelt name gets a suggestion: `"Clare" is not a declared speaker; did you
mean "Claire"?`

## Editors and encoding

Save files as **UTF-8** plain text (`.txt`). Word processors are fine for
writing: curly quotes, non-breaking spaces before `?` and `:`, and full-width
`：` `＠` `＞` are all understood. Copy the text into a plain-text file to send it.

## Converting existing material with a chat model

Give the model this, followed by your material:

```text
Convert the listening material below into the TTS Studio format, version 1.

Rules:
- The first line is exactly: #tts-studio 1
- Then: @lang fr-FR   (use the material's language code)
- Each exercise starts with "## " and a short title.
- Right under each title, an @id line with a short unique id, like @id u3-cafe.
- For a dialogue: declare every speaker on its own line, as
  "@speaker Name: female" or "@speaker Name: male", then write every line as
  "Name: what they say". Every line must start with a declared name.
- For a monologue or a set of sentences: no @speaker lines and no names; one
  sentence or paragraph per line.
- Put a translation under a line as a line starting with "> ".
- Write [1] for a one-second pause inside a line.
- Do not use Markdown formatting, bold, bullet points, quotation marks around
  lines, or code fences. Output only the converted text.

Example:
#tts-studio 1
@lang fr-FR

## Au café
@id u1-cafe
@speaker Serveur: male
@speaker Claire: female
Serveur: Bonjour madame, qu'est-ce que je vous sers ?
> Good morning, madam. What can I get you?
Claire: Un café crème, s'il vous plaît.
> A white coffee, please.

## Phrases utiles
@id u1-phrases
Je voudrais réserver une table pour deux.
> I would like to book a table for two.
```

Then paste the result into **Import scripts…** to check it.

## Voices

| Female | Male |
| --- | --- |
| Achernar | Achird |
| Aoede | Algenib |
| Autonoe | Algieba |
| Callirrhoe | Alnilam |
| Despina | Charon |
| Erinome | Enceladus |
| Gacrux | Fenrir |
| Kore | Iapetus |
| Laomedeia | Orus |
| Leda | Puck |
| Pulcherrima | Rasalgethi |
| Sulafat | Sadachbia |
| Vindemiatrix | Sadaltager |
| Zephyr | Schedar |
| | Umbriel |
| | Zubenelgenubi |

Every voice speaks every supported language.

## Versioning

The header carries the version. TTS Studio refuses a file with a newer version
than it understands rather than misreading it. Settings it does not know are
skipped with a note, so a file written for a later version still imports what
it can.

Reserved for later versions, so avoid them now: a parenthesis right after a
speaker's name (`Claire (furieuse): …`), and new line types starting with a
symbol other than `#`, `@` and `>`.
