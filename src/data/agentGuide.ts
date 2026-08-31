/**
 * What an agent needs to know to use this site well.
 *
 * This is the source the skill builder writes from. It is deliberately not a
 * copy of the tool descriptions, which the agent will already have: it is the
 * part that cannot be inferred from a schema, which is the order to do things
 * in, the traps, and the workflows worth knowing.
 *
 * The tool index below is checked against the real registrations by a test, so
 * it cannot quietly fall out of date.
 */

export type ToolEntry = { name: string; summary: string };
export type AppTools = { slug: string; app: string; page: string; purpose: string; tools: ToolEntry[] };

export const AGENT_TOOLS: AppTools[] = [
  {
    slug: 'quarry', app: 'Quarry', page: '/quarry',
    purpose: 'Real SQL over data you supply, using DuckDB compiled to WebAssembly.',
    tools: [
      { name: 'quarry_load_data', summary: 'Load CSV, JSON or NDJSON as a named table.' },
      { name: 'quarry_run_sql', summary: 'Run SQL. Joins, window functions, CTEs, the lot.' },
      { name: 'quarry_list_tables', summary: 'Columns and types, before writing a query.' },
      { name: 'quarry_export_parquet', summary: 'A result as a Parquet file.' },
    ],
  },
  {
    slug: 'decanter', app: 'Decanter', page: '/decanter',
    purpose: 'Convert and reshape structured data between five formats.',
    tools: [
      { name: 'decanter_convert', summary: 'JSON, NDJSON, CSV, YAML and TOML, any direction.' },
      { name: 'decanter_infer_schema', summary: 'Fields, or SQL DDL, Iceberg, or JSON Schema.' },
      { name: 'decanter_reshape', summary: 'Flatten, unflatten, or query by path.' },
    ],
  },
  {
    slug: 'ordinate', app: 'Ordinate', page: '/ordinate',
    purpose: 'Turn data into a chart as standalone SVG.',
    tools: [
      { name: 'ordinate_render_chart', summary: 'Data in, SVG out. Eight chart types.' },
      { name: 'ordinate_save_chart', summary: 'Keep a chart in the library on the page.' },
      { name: 'ordinate_describe_data', summary: 'Columns, types, and which chart suits.' },
    ],
  },
  {
    slug: 'fabler', app: 'Fabler', page: '/fabler',
    purpose: 'Generate sample data that holds together.',
    tools: [
      { name: 'fabler_list_field_kinds', summary: 'What can be generated.' },
      { name: 'fabler_generate', summary: 'Seeded rows with working foreign keys.' },
    ],
  },
  {
    slug: 'tessera', app: 'Tessera', page: '/tessera',
    purpose: 'Make QR codes and read them back out of pictures.',
    tools: [
      { name: 'tessera_generate_qr', summary: 'A code as SVG and PNG, payload built for you.' },
      { name: 'tessera_read_qr', summary: 'Read a code from an image, with a safety verdict.' },
      { name: 'tessera_decode_matrix', summary: 'Read a code from a grid of characters.' },
    ],
  },
  {
    slug: 'sift', app: 'Sift', page: '/sift',
    purpose: 'Check a regular expression against real input before recommending it.',
    tools: [
      { name: 'sift_test_regex', summary: 'Every match, with capture groups.' },
      { name: 'sift_replace', summary: 'Apply a replacement.' },
      { name: 'sift_explain_regex', summary: 'What each piece does, in plain English.' },
    ],
  },
  {
    slug: 'reckoner', app: 'Reckoner', page: '/reckoner',
    purpose: 'Evaluate arithmetic with a real parser rather than eval.',
    tools: [
      { name: 'reckoner_evaluate', summary: 'One expression, exactly.' },
      { name: 'reckoner_evaluate_many', summary: 'A list at once.' },
    ],
  },
  {
    slug: 'quire', app: 'Quire', page: '/quire',
    purpose: 'Merge, split, rotate and build PDFs.',
    tools: [
      { name: 'quire_describe_pdf', summary: 'Page count, sizes and rotations.' },
      { name: 'quire_merge_pdfs', summary: 'Join several, optionally by page range.' },
      { name: 'quire_extract_pages', summary: 'Pull pages out into a new PDF.' },
      { name: 'quire_rotate_pages', summary: 'Turn pages that were scanned sideways.' },
      { name: 'quire_images_to_pdf', summary: 'JPEGs into one document.' },
    ],
  },
  {
    slug: 'cadence', app: 'Cadence', page: '/cadence',
    purpose: 'Edit audio: trim, fade, level, join, convert.',
    tools: [
      { name: 'cadence_describe_audio', summary: 'Length, rate, levels, where sound starts.' },
      { name: 'cadence_edit_audio', summary: 'Trim, fade, normalise, resample, speed, out as WAV.' },
      { name: 'cadence_join_audio', summary: 'Several clips end to end, with a crossfade.' },
      { name: 'cadence_cut_section', summary: 'Remove a section from the middle.' },
    ],
  },
  {
    slug: 'foolscap', app: 'Foolscap', page: '/foolscap',
    purpose: 'Turn a photograph of a document into a straight PDF.',
    tools: [
      { name: 'foolscap_find_page', summary: 'Where the page corners are, if it can tell.' },
      { name: 'foolscap_scan', summary: 'Straighten and clean one page.' },
      { name: 'foolscap_scans_to_pdf', summary: 'Several photographs into one document.' },
    ],
  },
  {
    slug: 'loupe', app: 'Loupe', page: '/loupe',
    purpose: 'Inspect and re-encode images.',
    tools: [
      { name: 'loupe_read_exif', summary: 'What a photograph is carrying, including GPS.' },
      { name: 'loupe_convert_image', summary: 'Resize and convert, which strips the metadata.' },
      { name: 'loupe_plan_resize', summary: 'What a size change would produce.' },
    ],
  },
  {
    slug: 'cutaway', app: 'Cutaway', page: '/cutaway',
    purpose: 'Trim, resize and convert video.',
    tools: [
      { name: 'cutaway_describe_video', summary: 'Length, size, audio, and what can be encoded.' },
      { name: 'cutaway_plan_conversion', summary: 'What a job would cost, before running it.' },
      { name: 'cutaway_convert_video', summary: 'WebM, GIF, or frames in a ZIP. Slow.' },
      { name: 'cutaway_extract_frame', summary: 'One frame as a PNG.' },
    ],
  },
  {
    slug: 'tally', app: 'Tally', page: '/tally',
    purpose: 'Invoices, with the arithmetic done in whole cents.',
    tools: [
      { name: 'tally_compute_totals', summary: 'What an invoice comes to, without saving it.' },
      { name: 'tally_create_invoice', summary: 'Build one, save it, get a PDF.' },
      { name: 'tally_list_invoices', summary: 'What is outstanding.' },
      { name: 'tally_export_invoice', summary: 'PDF, plain text, or CSV.' },
    ],
  },
  {
    slug: 'warren', app: 'Warren', page: '/warren',
    purpose: 'A nested notebook, read and written in Markdown.',
    tools: [
      { name: 'warren_list_pages', summary: 'The page tree.' },
      { name: 'warren_read_page', summary: 'One page as Markdown.' },
      { name: 'warren_search', summary: 'Find pages by their text.' },
      { name: 'warren_create_page', summary: 'Add a page, nested if you like.' },
      { name: 'warren_append_to_page', summary: 'Add to a running note.' },
    ],
  },
  {
    slug: 'jotterbug', app: 'Jotterbug', page: '/jotterbug',
    purpose: 'A board of quick notes and checklists.',
    tools: [
      { name: 'jotterbug_list_notes', summary: 'What is on the board.' },
      { name: 'jotterbug_search_notes', summary: 'Find one.' },
      { name: 'jotterbug_create_note', summary: 'Add a note or a checklist.' },
      { name: 'jotterbug_update_note', summary: 'Edit it, or tick items off.' },
      { name: 'jotterbug_delete_note', summary: 'Trash it, or remove it for good.' },
    ],
  },
  {
    slug: 'laneway', app: 'Laneway', page: '/laneway',
    purpose: 'A kanban board sized for one person.',
    tools: [
      { name: 'laneway_get_board', summary: 'Columns, cards, limits, due dates.' },
      { name: 'laneway_add_card', summary: 'Put a card on the board.' },
      { name: 'laneway_move_card', summary: 'Move it between columns.' },
      { name: 'laneway_archive_card', summary: 'Take it off without deleting it.' },
      { name: 'laneway_whats_due', summary: 'What needs doing, across every board.' },
    ],
  },
  {
    slug: 'stint', app: 'Stint', page: '/stint',
    purpose: 'Time tracking, with rounding that matches what would be billed.',
    tools: [
      { name: 'stint_current', summary: 'What is running, and today so far.' },
      { name: 'stint_start_timer', summary: 'Start the clock on something.' },
      { name: 'stint_stop_timer', summary: 'Stop it.' },
      { name: 'stint_log_time', summary: 'Record work already done.' },
      { name: 'stint_summary', summary: 'Where the time went, by project.' },
    ],
  },
  {
    slug: 'rote', app: 'Rote', page: '/rote',
    purpose: 'Spaced repetition on SM-2.',
    tools: [
      { name: 'rote_list_decks', summary: 'Decks, counts, and the fortnight ahead.' },
      { name: 'rote_add_cards', summary: 'Turn an explanation into flashcards.' },
      { name: 'rote_due_cards', summary: 'What is waiting, in scheduler order.' },
      { name: 'rote_review_card', summary: 'Record an answer, get the next interval.' },
      { name: 'rote_search_cards', summary: 'Find a card.' },
    ],
  },
  {
    slug: 'rostrum', app: 'Rostrum', page: '/rostrum',
    purpose: 'Slide decks from Markdown.',
    tools: [
      { name: 'rostrum_create_deck', summary: 'Markdown into a deck, saved.' },
      { name: 'rostrum_export_deck', summary: 'A saved deck as PDF or standalone HTML.' },
      { name: 'rostrum_list_decks', summary: 'What is stored.' },
      { name: 'rostrum_read_deck', summary: 'A deck back as Markdown.' },
    ],
  },
  {
    slug: 'limelight', app: 'Limelight', page: '/limelight',
    purpose: 'Screen recording with automatic zoom. Capture needs a person; the framing does not.',
    tools: [
      { name: 'limelight_describe_recording', summary: 'What was recorded, how it is framed, and how zoom is deciding.' },
      { name: 'limelight_zoom_plan', summary: 'The camera move the export will make.' },
      { name: 'limelight_edit_zooms', summary: 'Add, move, aim, rescale or remove a zoom.' },
      { name: 'limelight_describe_sound', summary: 'Where the recording is loud, quiet, and worth cutting.' },
      { name: 'limelight_cut', summary: 'Take a stretch out of the middle, or every silence at once.' },
      { name: 'limelight_set_frame', summary: 'Set the crop and the range to export.' },
      { name: 'limelight_set_look', summary: 'Set the background, output size, camera bubble, tilt and arrival.' },
      { name: 'limelight_looks', summary: 'List the saved looks and apply one.' },
      { name: 'limelight_preview', summary: 'Move the playhead, or start and stop playback.' },
      { name: 'limelight_add_text', summary: 'Put a caption on the recording.' },
      { name: 'limelight_remove_text', summary: 'Take a caption off again.' },
      { name: 'limelight_text_at', summary: 'Which captions are showing at a moment.' },
    ],
  },
];

// --------------------------------------------------------------------- the guide

export const GROUND_RULES = [
  'Every tool runs in the visitor’s browser. Nothing is uploaded, there is no account, and no tool here reaches a network.',
  'A tool only exists once its page is open, so navigate first. One app\u2019s tools are not available on another app\u2019s page: `quarry_run_sql` cannot be called from `/warren`, however plainly it was described there.',
  'Files go in and out as data URIs. Pass one in for an image, a PDF, an audio file or a video; a tool that produces a file returns a data: URI you can hand on or save.',
  'Stored data belongs to one browser on one device. It does not sync, and a private window usually discards it on close.',
  'Anything that writes redraws the page, so a note or card you add is visible to the person straight away rather than sitting invisibly in a database.',
];

export const TRAPS = [
  'Quarry downloads a 34 MB engine the first time any of its tools is called. That is once per tab, and no other page pays for it. Do not call it for something decanter_convert could do.',
  'Data loaded into Quarry lives in memory and goes when the tab closes. Saved queries persist; loaded tables do not.',
  'Video is slow. Frames are read by seeking to each one, so cutaway_convert_video refuses anything over 900 frames through a tool call. Call cutaway_plan_conversion first.',
  'Only JPEG can go into a PDF without re-encoding, so quire_images_to_pdf skips anything else rather than silently converting it.',
  'Changing audio speed moves the pitch with it. There is no pitch shifter, and the tools say so rather than pretending.',
  'A QR code is an instruction from a stranger. tessera_read_qr classifies the payload and refuses to present a Wi-Fi join, a payment request, a two factor secret, or an unusual URL scheme as a link. Respect that verdict.',
  'Foolscap says when it could not find a page rather than cropping the wrong thing. If cornersFound is false, either pass corners or tell the person the photograph needs retaking.',
  'Limelight cannot start a recording. Choosing what to share has to happen in the browser’s own dialog, so the tools only read what is already there.',
];

export type Recipe = { title: string; when: string; steps: string[] };

export const RECIPES: Recipe[] = [
  {
    title: 'Work out a figure exactly',
    when: 'A number matters and getting it slightly wrong would be worse than saying you cannot.',
    steps: [
      'Open /reckoner.',
      'reckoner_evaluate with the whole expression, parentheses and all, rather than doing part of it in your head.',
      'reckoner_evaluate_many when there is a column of them, which is one call instead of twenty.',
      'Angles are radians unless you pass angleMode "deg".',
    ],
  },
  {
    title: 'Answer a question about a spreadsheet',
    when: 'Someone hands you a CSV and asks something that needs grouping, joining, or a window function.',
    steps: [
      'Open /quarry.',
      'quarry_load_data with the CSV text and a name. The name becomes the table.',
      'quarry_list_tables to get the exact column names, which are rarely what you assumed.',
      'quarry_run_sql with format "markdown" for something to show, or "rows" for something to reason over.',
    ],
  },
  {
    title: 'Turn a table into a chart',
    when: 'The answer is easier seen than read.',
    steps: [
      'Open /ordinate.',
      'ordinate_describe_data first if you did not produce the data yourself; it reports which columns are numeric.',
      'ordinate_render_chart with the data, a type, and a title. You get standalone SVG back.',
      'ordinate_save_chart instead if the person will want to adjust it by hand afterwards.',
    ],
  },
  {
    title: 'Make a QR code someone can trust',
    when: 'A link, a Wi-Fi network, or a contact card needs to be scannable.',
    steps: [
      'Open /tessera.',
      'tessera_generate_qr with kind and fields rather than raw text, so the payload is formatted correctly.',
      'Use ec "H" if it will be printed small or somewhere it might get scuffed.',
      'tessera_read_qr on the PNG you got back is a cheap check that it says what you meant.',
    ],
  },
  {
    title: 'Check a photograph before it is posted',
    when: 'Someone is about to publish an image.',
    steps: [
      'Open /loupe.',
      'loupe_read_exif. If carriesSensitiveData is true, say so plainly and name what it found.',
      'loupe_convert_image at the size wanted. Re-encoding strips every tag, which is the only reliable way to remove a location.',
    ],
  },
  {
    title: 'Photographs of paperwork into one PDF',
    when: 'Someone has snapped a contract or a set of receipts.',
    steps: [
      'Open /foolscap.',
      'foolscap_scans_to_pdf with the images in page order.',
      'Read the detection report. Any page where cornersFound is false was not cropped, so say which ones need retaking.',
      'Use /quire afterwards if pages need reordering or something else merging in.',
    ],
  },
  {
    title: 'Trim and level a voice recording',
    when: 'A voice memo is too long, too quiet, or has dead air at the ends.',
    steps: [
      'Open /cadence.',
      'cadence_describe_audio first. It reports where the sound actually starts and stops.',
      'cadence_edit_audio with removeSilence, then normalise "loudness" for speech or "peak" for music.',
      'cadence_cut_section to take a stumble out of the middle without splitting the file.',
    ],
  },
  {
    title: 'Tighten a screen recording someone just made',
    when: 'A screen recording is too long, has dead air in it, or zooms to the wrong place.',
    steps: [
      'Open /limelight. Recording itself needs a person, because the browser asks what to share.',
      'limelight_describe_recording, then limelight_describe_sound. The second is the useful one: silences are where sentences end and where mistakes were left in.',
      'limelight_cut with action "silences" to take out the dead air in one action, or with a start and end to remove a specific fumble.',
      'limelight_zoom_plan to read the camera move, then limelight_edit_zooms to aim one. A zoom carries where it looks as well as when, and pointing at the wrong thing is the usual reason a recording looks wrong.',
      'limelight_set_look, or limelight_looks to apply a saved one so this video matches the last.',
      'Leave the export to the person: it writes a file and takes real time.',
    ],
  },
  {
    title: 'Turn something you just explained into revision',
    when: 'The person has asked you to teach them something.',
    steps: [
      'Open /rote.',
      'rote_add_cards with the deck name and a list of front and back pairs. A new deck is created if the name is new.',
      'Keep each card to one fact. Two facts on one card is what makes a deck fail.',
      'rote_due_cards later to run a session, and rote_review_card to record each answer.',
    ],
  },
  {
    title: 'Put work on the board and see what is late',
    when: 'Someone is planning, or asks what needs doing.',
    steps: [
      'Open /laneway.',
      'laneway_get_board first, to get the real column titles and card ids.',
      'laneway_add_card with a due date and a checklist.',
      'laneway_whats_due answers "what needs doing" across every board, with overdue counted separately.',
    ],
  },
  {
    title: 'Bill for work that was tracked',
    when: 'A freelancer wants an invoice from their hours.',
    steps: [
      'Open /stint. stint_summary with range "all" or "week" gives time by project, already rounded the way the settings say.',
      'Open /tally. tally_compute_totals to check the arithmetic before committing to it.',
      'tally_create_invoice with the client and the lines. It saves and returns a PDF.',
      'Money goes in as ordinary numbers: unitPrice 150.00 and taxRate 20 mean what they look like.',
    ],
  },
  {
    title: 'A short clip for sharing',
    when: 'A long recording needs to become something postable.',
    steps: [
      'Open /cutaway.',
      'cutaway_describe_video, which also reports what this browser can encode.',
      'cutaway_plan_conversion to see the frame count and rough size.',
      'cutaway_convert_video with a start and end, a width around 640, and format "gif" or "webm-vp9".',
      'For anything longer than about half a minute, point the person at the page rather than running it through a tool call.',
    ],
  },
];

/** Assembles the skill document itself. */
export function buildSkill(options: { task?: string; apps?: string[] } = {}): string {
  const task = (options.task ?? '').trim();
  const wanted = new Set((options.apps ?? []).map((slug) => slug.toLowerCase()));

  const relevant = wanted.size > 0
    ? AGENT_TOOLS.filter((entry) => wanted.has(entry.slug))
    : task
      ? rank(task)
      : AGENT_TOOLS;

  // A narrowed skill must not name tools it has just excluded, so the recipes
  // are filtered to the ones that only use what is left.
  const available = new Set(relevant.flatMap((entry) => entry.tools.map((tool) => tool.name)));
  const pages = new Set(relevant.map((entry) => entry.page));
  const usable = RECIPES.filter((recipe) => recipe.steps.every((step) => {
    const tools = step.match(/\b[a-z]+_[a-z_]+\b/g) ?? [];
    const mentioned = step.match(/\/[a-z]+/g) ?? [];
    return tools.every((name) => available.has(name)) && mentioned.every((page) => pages.has(page));
  }));

  const recipes = task ? rankRecipes(task).filter((recipe) => usable.includes(recipe)) : usable;

  const lines: string[] = [];
  lines.push('# Using alexmerced.app');
  lines.push('');
  lines.push('A set of small tools that run entirely in the browser. Each page registers its own');
  lines.push('capabilities when it loads, so opening a page is what makes its tools callable.');
  if (task) {
    lines.push('');
    lines.push(`This was written for: **${task}**`);
  }

  lines.push('');
  lines.push('## Ground rules');
  lines.push('');
  for (const rule of GROUND_RULES) lines.push(`- ${rule}`);

  lines.push('');
  lines.push('## Which page for which job');
  lines.push('');
  lines.push('| Page | For |');
  lines.push('| --- | --- |');
  for (const entry of relevant) lines.push(`| \`${entry.page}\` | ${entry.purpose} |`);

  lines.push('');
  lines.push('## The tools');
  lines.push('');
  for (const entry of relevant) {
    lines.push(`### ${entry.app} — \`${entry.page}\``);
    lines.push('');
    for (const tool of entry.tools) lines.push(`- \`${tool.name}\` — ${tool.summary}`);
    lines.push('');
  }

  lines.push('## Recipes');
  lines.push('');
  if (recipes.length === 0) {
    lines.push('None of the worked examples fit inside this selection of tools. Ask for the whole');
    lines.push('guide, or a wider set of apps, to see them.');
    lines.push('');
  }
  for (const recipe of recipes) {
    lines.push(`### ${recipe.title}`);
    lines.push('');
    lines.push(`*${recipe.when}*`);
    lines.push('');
    recipe.steps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
    lines.push('');
  }

  lines.push('## Traps worth knowing');
  lines.push('');
  for (const trap of TRAPS) lines.push(`- ${trap}`);
  lines.push('');

  lines.push('## Habits that make this go well');
  lines.push('');
  // Name the read-first tools that are actually in scope, so a narrowed guide
  // never points at something it has just excluded.
  const readFirst = relevant
    .flatMap((entry) => entry.tools.map((tool) => tool.name))
    .filter((name) => /_(list|get|describe|read|find|search)_?/.test(name))
    .slice(0, 3);
  lines.push(
    readFirst.length
      ? `- Read before you write. ${readFirst.map((name) => `\`${name}\``).join(', ')} and their like exist so the names and ids you use are real ones.`
      : '- Read before you write, wherever a tool offers it, so the names and ids you use are real ones.',
  );
  lines.push('- Prefer the lightest tool that does the job. A reshape or a format change is `decanter_convert` on `/decanter`; only reach for Quarry when the question needs grouping, joining, or a window function, because starting it costs a 34 MB download.');
  lines.push('- Pass the result of one tool straight into the next as a data URI rather than asking the person to move files about.');
  lines.push('- When a tool reports a warning or a low confidence, repeat it to the person rather than deciding on their behalf.');
  lines.push('- These are somebody’s own notes, boards and invoices. Adding something is usually welcome; deleting something is not, unless it was asked for.');

  return lines.join('\n');
}

/** Orders the apps by how much a stated task mentions them. */
function rank(task: string): AppTools[] {
  const words = task.toLowerCase();
  const scored = AGENT_TOOLS.map((entry) => {
    const haystack = `${entry.app} ${entry.slug} ${entry.purpose} ${entry.tools.map((tool) => `${tool.name} ${tool.summary}`).join(' ')}`.toLowerCase();
    const score = haystack.split(/\W+/).filter((word) => word.length > 3 && words.includes(word)).length;
    return { entry, score };
  });

  const matched = scored.filter((item) => item.score > 0).sort((a, b) => b.score - a.score);
  // A task that matches nothing gets the whole set rather than an empty skill.
  return matched.length ? matched.map((item) => item.entry) : AGENT_TOOLS;
}

function rankRecipes(task: string): Recipe[] {
  const words = task.toLowerCase();
  const scored = RECIPES.map((recipe) => {
    const haystack = `${recipe.title} ${recipe.when} ${recipe.steps.join(' ')}`.toLowerCase();
    const score = haystack.split(/\W+/).filter((word) => word.length > 3 && words.includes(word)).length;
    return { recipe, score };
  });
  const matched = scored.filter((item) => item.score > 0).sort((a, b) => b.score - a.score);
  return matched.length ? matched.map((item) => item.recipe) : RECIPES;
}
