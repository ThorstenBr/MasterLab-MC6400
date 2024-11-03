/* 7-Segment / LED emulation
 * for the virtual Philips MCU6400 "Microcomputer Master Lab".
 *
 * https://github.com/ThorstenBr/MasterLab-MC6400
 * 
 * Copyright 2024 Thorsten Brehm, brehmt (at) gmail com
 */

var led_selected  = false;
var led_array     = [];
var segment_array = [];
var segment_state = [255,255,255,255,255,255,255,255];

function clear_digits()
{
	for (var d=0;d<8;d++)
	{
		if (segment_state[d] != 0)
		{
			var Segments = segment_array[d];
			for (var s=1;s<8;s++)
			{
				if (segment_state[d] & (1<<s))
					Segments[s-1].style.visibility = "hidden";
			}
			segment_state[d] = 0;
		}
		for (var led=0;led<8;led++)
		{
			led_array[led].checked = false;
		}
	}
}

// show 7segment data: digit (0..7, left to right)
function show_7segment(digit, value)
{
	if (segment_state[digit] == (segment_state[digit]|value))
		return;
	if (led_selected && (digit==3))
	{
		for (var s=0;s<8;s++)
		{
			var mask = (1<<s);
			if ((value & mask) != (segment_state[digit] & mask))
			{
				led_array[s].checked = (value & mask) != 0;
			}
		}
	}
	else
	{
		var Segments = segment_array[digit];
		for (var s=1;s<8;s++)
		{
			var mask = (1<<s);
			if ((value & mask) != (segment_state[digit] & mask))
			{
				if (value & mask)
					Segments[s-1].style.visibility = "visible";
				else
					Segments[s-1].style.visibility = "hidden";
			}
		}
	}
	segment_state[digit] = value;
}

function segment_array_init()
{
	for (var s=0;s<8;s++)
	{
		var segments = document.getElementById("digit"+s).children;
		segment_array.push(segments);
	}
	for (var led=0;led<8;led++)
	{
		led_array[led] = document.getElementById("LED"+led);
	}
	clear_digits();
}

segment_array_init();
