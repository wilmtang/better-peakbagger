// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { instagramEmbedHeight } from '../../src/reports/instagram-sizing.js';

test('only finite positive numeric provider sizes can influence the embed height',()=>{
    for(const value of [undefined,null,'640','640px',{},[],0,-1,NaN,Infinity,-Infinity])assert.equal(instagramEmbedHeight(value),null);
    for(const [input,expected]of [[1,320],[319,320],[640.2,641],[1200,1200],[100000,1600]]){
        assert.equal(instagramEmbedHeight(input),expected);
        assert.equal(instagramEmbedHeight(expected),expected,'frame-boundary validation is idempotent');
    }
});
