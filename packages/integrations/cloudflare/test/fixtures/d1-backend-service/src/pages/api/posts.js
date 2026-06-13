export const prerender = false;

export async function POST({ request, locals }) {
	const input = await request.json();

	locals.d1.query(`
		CREATE TABLE IF NOT EXISTS posts (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			title TEXT NOT NULL
		)
	`);

	const post = locals.d1.queryOne(
		'INSERT INTO posts (title) VALUES (?) RETURNING id, title',
		[input.title],
	);

	return Response.json(post, { status: 201 });
}
