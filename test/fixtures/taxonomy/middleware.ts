import { NextResponse } from 'next/server';
export function middleware(req: any) {
  const h = req.headers.get('hostname');
  return NextResponse.rewrite(new URL('/x', req.url));
}
