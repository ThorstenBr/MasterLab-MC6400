/* Script Utilities
 *
 * https://github.com/ThorstenBr/MasterLab-MC6400
 * 
 * Copyright 2024 Thorsten Brehm, brehmt (at) gmail com
 */

function gui(id)
{
	var e=document.getElementById(id);
	if (e==null)
		console.log("ERROR: missing GUI element", id);
	return e;
}

function hex(v)
{
	return v.toString(16).toUpperCase();
}

function hex8(v)
{
	var s = hex(v);
	while (s.length < 2)
		s = "0"+s;
	return s;
}

function hexi8(v)
{
	var s = "";
	if (v<0)
		s = hex(-v);
	else
		s = hex(v);
	while (s.length < 2)
		s = "0"+s;
	if (v<0)
		return "-"+s;
	return "+"+s;
}

function hex16(v)
{
	var s = hex(v);
	while (s.length < 4)
		s = "0"+s;
	return s;
}

function bin8(v)
{
	var s = v.toString(2);
	while (s.length < 8)
		s = "0"+s;
	return s;
}
